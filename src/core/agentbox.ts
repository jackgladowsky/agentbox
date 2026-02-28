/**
 * AgentBox — the singleton agent instance.
 *
 * All connections (Telegram, TUI, etc.) talk to this one agent.
 * Session continuity via Claude Agent SDK session IDs.
 */

import { runAgent, type AgentEvent, type AgentEventCallback } from "./agent.js";
import { loadWorkspaceContext } from "./workspace.js";
import { loadAgentConfig } from "./config.js";
import { loadSession, saveSession, clearSession as clearSessionFile } from "./checkpoint.js";

export type { AgentEvent } from "./agent.js";

export type MessageSource = {
  /** Unique ID for routing replies back — e.g. telegram:123456, tui:local */
  id: string;
  /** Human-readable label shown in logs */
  label: string;
};

export type AgentResponseCallback = (event: AgentEvent, source: MessageSource) => void;

/**
 * Watchdog inactivity timeout.
 *
 * Resets on every agent event. Only fires if the stream goes completely
 * silent — 5 minutes of silence means dead stream.
 */
const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;

class AgentBox {
  private systemPrompt = "";
  private _sessionId: string | null = null;
  private _model: string | undefined;
  private listeners = new Map<string, AgentResponseCallback>();
  private queue: Array<{ content: string; source: MessageSource }> = [];
  private busy = false;
  private _name = "agent";
  private _initialized = false;
  private abortController: AbortController | null = null;

  async init(): Promise<void> {
    if (this._initialized) return;
    const { systemPrompt, agentName } = await loadWorkspaceContext();
    const config = await loadAgentConfig(agentName);
    this._name = config.name ?? agentName;
    this._model = config.model;
    this.systemPrompt = systemPrompt;

    // Restore session from last run
    this._sessionId = await loadSession();

    this._initialized = true;
    const sessionInfo = this._sessionId ? `session: ${this._sessionId}` : "new session";
    console.log(`[AgentBox] ${this._name} initialized (${sessionInfo})`);
  }

  get name(): string {
    return this._name;
  }

  get modelId(): string {
    return this._model ?? "claude-sonnet-4-6";
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  /** Subscribe to all agent events tagged with originating source. Returns unsubscribe fn. */
  subscribe(id: string, callback: AgentResponseCallback): () => void {
    this.listeners.set(id, callback);
    return () => this.listeners.delete(id);
  }

  /** Send a message to the agent. Queues if busy so connections don't clobber each other. */
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
    if (!this._initialized) throw new Error("AgentBox not initialized — call agentbox.init() first");

    this.abortController = new AbortController();

    let watchdog: NodeJS.Timeout | null = null;

    const resetWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        console.error(
          `[AgentBox] Stream silent for ${INACTIVITY_TIMEOUT_MS / 1000}s — ` +
          `aborting. (${source.id})`
        );
        this.abortController?.abort();
      }, INACTIVITY_TIMEOUT_MS);
    };

    resetWatchdog();

    try {
      const { sessionId } = await runAgent({
        prompt: content,
        systemPrompt: this.systemPrompt,
        sessionId: this._sessionId ?? undefined,
        model: this._model,
        abortSignal: this.abortController.signal,
        onEvent: (event) => {
          resetWatchdog();
          for (const cb of this.listeners.values()) cb(event, source);
        },
      });

      // Persist session ID for next time
      if (sessionId) {
        this._sessionId = sessionId;
        await saveSession(sessionId).catch(err =>
          console.error("[AgentBox] Failed to save session:", err)
        );
      }
    } catch (err: any) {
      console.error(`[AgentBox] Agent error (${source.id}): ${err.message}`);
      throw err;
    } finally {
      if (watchdog) clearTimeout(watchdog);
      this.abortController = null;
    }
  }

  abort(): void {
    this.abortController?.abort();
  }

  async clearSession(): Promise<void> {
    this._sessionId = null;
    await clearSessionFile();
  }

  setModel(modelId: string): void {
    this._model = modelId;
  }
}

// Singleton export
export const agentbox = new AgentBox();
