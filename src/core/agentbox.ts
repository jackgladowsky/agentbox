/**
 * AgentBox — the singleton agent instance.
 *
 * All connections (Telegram, TUI, etc.) talk to this one agent.
 * Session history lives in Claude Code's storage — we track a session ID.
 *
 * Replaces the old pi-agent-core based implementation.
 * auth.ts and checkpoint.ts are now dead — session ID replaces both.
 */

import { runTurn, saveSessionId, loadSessionId, clearSessionId, type AgentEvent } from "./agent.js";
import { loadWorkspaceContext } from "./workspace.js";
import { loadAgentConfig } from "./config.js";

export type MessageSource = {
  /** Unique ID for routing replies back — e.g. telegram:123456, tui:local */
  id: string;
  /** Human-readable label shown in logs */
  label: string;
};

export type AgentResponseCallback = (event: AgentEvent, source: MessageSource) => void;

/**
 * Watchdog inactivity timeout.
 * Claude Code's subprocess normally completes and exits cleanly, so this
 * only fires if the process hangs silently without producing output.
 */
const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

class AgentBox {
  private systemPrompt = "";
  private sessionId: string | undefined = undefined;
  private agentName = "agent";
  private model: string | undefined = undefined;
  private listeners = new Map<string, AgentResponseCallback>();
  private queue: Array<{ content: string; source: MessageSource }> = [];
  private busy = false;
  private _name = "agent";

  async init(): Promise<void> {
    const { systemPrompt, agentName } = await loadWorkspaceContext();
    const config = await loadAgentConfig(agentName);

    this._name = config.name ?? agentName;
    this.agentName = agentName;
    this.systemPrompt = systemPrompt;
    this.model = config.model;

    // Restore session ID from disk (replaces checkpoint restore)
    this.sessionId = (await loadSessionId(agentName)) ?? undefined;

    console.log(
      `[AgentBox] ${this._name} initialized (claude-code subprocess)` +
      (this.sessionId ? ` — resuming session ${this.sessionId.slice(0, 8)}...` : " — new session")
    );
  }

  get name(): string { return this._name; }

  /** Subscribe to all agent events tagged with originating source. Returns unsubscribe fn. */
  subscribe(id: string, callback: AgentResponseCallback): () => void {
    this.listeners.set(id, callback);
    return () => this.listeners.delete(id);
  }

  /** Send a message to the agent. Queues if busy. */
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

    // Watchdog: fires if the subprocess goes completely silent
    let watchdog: NodeJS.Timeout | null = null;
    const resetWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        console.error(`[AgentBox] Subprocess silent for ${INACTIVITY_TIMEOUT_MS / 1000}s — possible hang (${source.id})`);
        emit({ type: "error", message: `Agent stream timed out after ${INACTIVITY_TIMEOUT_MS / 1000}s` });
      }, INACTIVITY_TIMEOUT_MS);
    };

    try {
      resetWatchdog();

      const stream = runTurn(content, {
        sessionId: this.sessionId,
        systemPrompt: this.sessionId ? undefined : this.systemPrompt,
        model: this.model,
      });

      for await (const event of stream) {
        resetWatchdog();

        if (event.type === "done") {
          // Persist the session ID so the next restart resumes
          this.sessionId = event.sessionId;
          await saveSessionId(this.agentName, event.sessionId);
        }

        emit(event);
      }
    } catch (err: any) {
      emit({ type: "error", message: err.message ?? String(err) });
    } finally {
      if (watchdog) clearTimeout(watchdog);
    }
  }

  /** Clear session: next turn starts a fresh conversation. */
  clearMessages(): void {
    this.sessionId = undefined;
    clearSessionId(this.agentName).catch(() => {});
    console.log(`[AgentBox] Session cleared — next turn starts fresh.`);
  }

  /** No-op: Claude Code handles model selection. Kept for API compatibility. */
  setModel(modelId: string): void {
    this.model = modelId;
    console.log(`[AgentBox] Model set to ${modelId} (takes effect next turn).`);
  }

  /** No-op: Claude Code doesn't expose thinking level externally. */
  setThinkingLevel(_level: string): void {
    console.log(`[AgentBox] setThinkingLevel: not supported with claude-code subprocess.`);
  }

  /** No abort handle on subprocess; would need to kill the proc. Future work. */
  abort(): void {
    console.warn(`[AgentBox] abort() not yet implemented for subprocess mode.`);
  }

  get messageCount(): number {
    // We don't track messages locally anymore — session history is in Claude Code
    return this.sessionId ? -1 : 0;
  }
}

// Singleton export
export const agentbox = new AgentBox();
