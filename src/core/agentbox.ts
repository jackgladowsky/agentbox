/**
 * AgentBox — the singleton agent instance.
 *
 * All connections (Telegram, TUI, etc.) talk to this one agent.
 * Conversation history is shared across all connections.
 */

import { type Agent, type AgentEvent } from "@mariozechner/pi-agent-core";
import { createAgent } from "./agent.js";
import { loadWorkspaceContext } from "./workspace.js";
import { loadAgentConfig } from "./config.js";
import { loadCheckpoint, clearCheckpoint } from "./checkpoint.js";

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
 * The timer resets on every agent event (tool calls, text deltas, turn boundaries,
 * etc.) and only fires if the stream goes completely silent. This means a task that
 * runs for hours is fine as long as it keeps emitting events — the timeout only
 * triggers when the LLM provider drops the connection without closing the stream.
 *
 * 5 minutes of silence = dead stream. Healthy agents always produce events.
 */
const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;

class AgentBox {
  private agent: Agent | null = null;
  private listeners = new Map<string, AgentResponseCallback>();
  private queue: Array<{ content: string; source: MessageSource }> = [];
  private busy = false;
  private _name = "agent";

  async init(): Promise<void> {
    if (this.agent) return;
    const { systemPrompt, agentName } = await loadWorkspaceContext();
    const config = await loadAgentConfig(agentName);
    this._name = config.name ?? agentName;
    this.agent = createAgent(systemPrompt, config.model, config.openrouterKey);
    const compactionModel = config.openrouterKey ? "openrouter/google/gemini-2.5-flash-lite" : "trim fallback";
    console.log(`[AgentBox] ${this._name} initialized — ${this.agent.state.model.id} (compaction: ${compactionModel})`);

    // Restore context from last session if a fresh checkpoint exists.
    const saved = await loadCheckpoint();
    if (saved && saved.length > 0) {
      this.agent.replaceMessages(saved);
      console.log(`[AgentBox] Context restored from checkpoint (${saved.length} messages).`);
    }
  }

  get name(): string {
    return this._name;
  }

  get instance(): Agent {
    if (!this.agent) throw new Error("AgentBox not initialized — call agentbox.init() first");
    return this.agent;
  }

  get messageCount(): number {
    return this.agent?.state.messages.length ?? 0;
  }

  /** Current messages — used for checkpoint saving on exit. */
  get messages() {
    return this.agent?.state.messages ?? [];
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
    const agent = this.instance;

    await new Promise<void>((resolve, reject) => {
      // Watchdog: fires if no agent event arrives within INACTIVITY_TIMEOUT_MS.
      // Resets on every event so long-running tasks with active tool calls are fine.
      // Only triggers when the stream goes completely silent (dead connection).
      let watchdog: NodeJS.Timeout | null = null;

      const resetWatchdog = () => {
        if (watchdog) clearTimeout(watchdog);
        watchdog = setTimeout(() => {
          console.error(
            `[AgentBox] Stream silent for ${INACTIVITY_TIMEOUT_MS / 1000}s — ` +
            `aborting hung agent. (${source.id})`
          );
          unsubscribe();
          this.abort();
          reject(new Error(
            `Agent stream inactive for ${INACTIVITY_TIMEOUT_MS / 1000}s — ` +
            `possible dropped connection. (${source.id})`
          ));
        }, INACTIVITY_TIMEOUT_MS);
      };

      const unsubscribe = agent.subscribe((event: AgentEvent) => {
        // Every event — text delta, tool call, turn boundary, anything — proves
        // the stream is alive. Reset the watchdog.
        resetWatchdog();

        for (const cb of this.listeners.values()) cb(event, source);

        if (event.type === "agent_end") {
          if (watchdog) clearTimeout(watchdog);
          unsubscribe();
          if (agent.state.error) {
            console.error(`[AgentBox] Agent error (${source.id}): ${agent.state.error}`);
          }
          resolve();
        }
      });

      // Start the watchdog immediately — if prompt() itself hangs before emitting
      // agent_start, we still want to detect it.
      resetWatchdog();

      agent.prompt(content).catch(err => {
        if (watchdog) clearTimeout(watchdog);
        unsubscribe();
        reject(err);
      });
    });
  }

  abort(): void { this.agent?.abort(); }

  clearMessages(): void {
    this.agent?.clearMessages();
    // Discard checkpoint so the next restart also starts fresh.
    clearCheckpoint().catch(() => {});
  }

  setModel(modelId: string): void { this.agent?.setModel({ ...this.instance.state.model, id: modelId }); }
  setThinkingLevel(level: "off" | "low" | "medium" | "high"): void { this.agent?.setThinkingLevel(level); }

}

// Singleton export
export const agentbox = new AgentBox();
