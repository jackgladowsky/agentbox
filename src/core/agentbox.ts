/**
 * AgentBox — the singleton agent instance.
 *
 * All connections (Telegram, etc.) talk to this one agent.
 * Session history lives in Claude Code's storage — we track a session ID.
 */

import { runTurn, saveSessionId, loadSessionId, clearSessionId, type AgentEvent } from "./agent.js";
export type { AgentEvent } from "./agent.js";
import { loadWorkspaceContext } from "./workspace.js";
import { loadAgentConfig } from "./config.js";

export type MessageSource = {
  id: string;
  label: string;
};

export type AgentResponseCallback = (event: AgentEvent, source: MessageSource) => void;

const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;

class AgentBox {
  private systemPrompt = "";
  private _sessionId: string | undefined = undefined;
  private agentName = "agent";
  private _model: string | undefined = undefined;
  private listeners = new Map<string, AgentResponseCallback>();
  private queue: Array<{ content: string; source: MessageSource }> = [];
  private busy = false;
  private _name = "agent";
  private _abortController: AbortController | null = null;
  private _initialized = false;

  async init(): Promise<void> {
    if (this._initialized) return;

    const { systemPrompt, agentName } = await loadWorkspaceContext();
    const config = await loadAgentConfig(agentName);

    this._name = config.name ?? agentName;
    this.agentName = agentName;
    this.systemPrompt = systemPrompt;
    this._model = config.model;
    this._sessionId = (await loadSessionId(agentName)) ?? undefined;
    this._initialized = true;

    console.log(
      `[AgentBox] ${this._name} initialized (claude-agent-sdk)` +
      (this._sessionId ? ` — resuming session ${this._sessionId.slice(0, 8)}...` : " — new session")
    );
  }

  get name(): string { return this._name; }
  get modelId(): string | undefined { return this._model; }
  get sessionId(): string | undefined { return this._sessionId; }

  subscribe(id: string, callback: AgentResponseCallback): () => void {
    this.listeners.set(id, callback);
    return () => this.listeners.delete(id);
  }

  async prompt(content: string, source: MessageSource): Promise<void> {
    this.queue.push({ content, source });
    if (!this.busy) await this._drainQueue();
  }

  private async _drainQueue(): Promise<void> {
    if (this.busy || this.queue.length === 0) return;
    this.busy = true;
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      await this._runPrompt(item.content, item.source);
    }
    this.busy = false;
  }

  private async _runPrompt(content: string, source: MessageSource): Promise<void> {
    const emit = (event: AgentEvent) => {
      for (const cb of this.listeners.values()) {
        try {
          cb(event, source);
        } catch (err) {
          console.error("[AgentBox] Subscriber error:", err);
        }
      }
    };

    this._abortController = new AbortController();

    let watchdog: NodeJS.Timeout | null = null;
    const resetWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        console.error(`[AgentBox] Inactivity timeout (${source.id}) — aborting.`);
        this.abort();
        emit({ type: "error", message: `Agent timed out after ${INACTIVITY_TIMEOUT_MS / 1000}s of inactivity` });
      }, INACTIVITY_TIMEOUT_MS);
    };

    try {
      resetWatchdog();

      const previousSessionId = this._sessionId;

      const stream = runTurn(content, {
        sessionId: this._sessionId,
        systemPrompt: this.systemPrompt,
        model: this._model,
        abortController: this._abortController,
      });

      for await (const event of stream) {
        resetWatchdog();

        if (event.type === "done") {
          // Detect session resume failure: SDK gave us a different session ID
          if (previousSessionId && event.sessionId && event.sessionId !== previousSessionId) {
            console.warn(
              `[AgentBox] Session changed: ${previousSessionId.slice(0, 8)}... → ${event.sessionId.slice(0, 8)}... ` +
              `(old session may have expired)`
            );
          }

          this._sessionId = event.sessionId;
          if (event.sessionId) {
            saveSessionId(this.agentName, event.sessionId).catch(err =>
              console.error("[AgentBox] Failed to persist session ID:", err)
            );
          }
        }

        emit(event);
      }
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        emit({ type: "error", message: err?.message ?? String(err) });
      }
    } finally {
      if (watchdog) clearTimeout(watchdog);
      this._abortController = null;
    }
  }

  abort(): void {
    this._abortController?.abort();
  }

  clearMessages(): void {
    this._sessionId = undefined;
    clearSessionId(this.agentName).catch(() => {});
    console.log(`[AgentBox] Session cleared — next turn starts fresh.`);
  }

  setModel(modelId: string): void {
    this._model = modelId;
    console.log(`[AgentBox] Model set to ${modelId}.`);
  }
}

export const agentbox = new AgentBox();
