/**
 * AgentBox — the singleton agent instance.
 *
 * All connections (Telegram, TUI, etc.) talk to this one agent.
 * Session history lives in Claude Code's storage — we track a session ID.
 */

import { runTurn, saveSessionId, loadSessionId, clearSessionId, type AgentEvent } from "./agent.js";
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
  private sessionId: string | undefined = undefined;
  private agentName = "agent";
  private model: string | undefined = undefined;
  private listeners = new Map<string, AgentResponseCallback>();
  private queue: Array<{ content: string; source: MessageSource }> = [];
  private busy = false;
  private _name = "agent";
  private _abortController: AbortController | null = null;

  async init(): Promise<void> {
    const { systemPrompt, agentName } = await loadWorkspaceContext();
    const config = await loadAgentConfig(agentName);

    this._name = config.name ?? agentName;
    this.agentName = agentName;
    this.systemPrompt = systemPrompt;
    this.model = config.model;
    this.sessionId = (await loadSessionId(agentName)) ?? undefined;

    console.log(
      `[AgentBox] ${this._name} initialized (claude-agent-sdk)` +
      (this.sessionId ? ` — resuming session ${this.sessionId.slice(0, 8)}...` : " — new session")
    );
  }

  get name(): string { return this._name; }

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
      for (const cb of this.listeners.values()) cb(event, source);
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

      const stream = runTurn(content, {
        sessionId: this.sessionId,
        systemPrompt: this.sessionId ? undefined : this.systemPrompt,
        model: this.model,
        abortController: this._abortController,
      });

      for await (const event of stream) {
        resetWatchdog();

        if (event.type === "done") {
          this.sessionId = event.sessionId;
          if (event.sessionId) await saveSessionId(this.agentName, event.sessionId);
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
    this.sessionId = undefined;
    clearSessionId(this.agentName).catch(() => {});
    console.log(`[AgentBox] Session cleared — next turn starts fresh.`);
  }

  setModel(modelId: string): void {
    this.model = modelId;
    console.log(`[AgentBox] Model set to ${modelId} (takes effect next turn).`);
  }

  setThinkingLevel(_level: string): void {
    console.log(`[AgentBox] setThinkingLevel: not supported with claude-agent-sdk.`);
  }

  get messageCount(): number {
    return this.sessionId ? -1 : 0;
  }
}

export const agentbox = new AgentBox();
