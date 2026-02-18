/**
 * Rex — the singleton agent instance.
 *
 * All connections (Discord, TUI, etc.) talk to this one agent.
 * Conversation history is shared and persistent across all channels.
 */

import { type Agent, type AgentEvent } from "@mariozechner/pi-agent-core";
import { createAgent, DEFAULT_MODEL } from "./agent.js";
import { loadWorkspaceContext } from "./workspace.js";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTBOX_DIR = join(__dirname, "..");

export type MessageSource = {
  /** Unique ID for routing replies back — e.g. discord:channel:123, tui:local */
  id: string;
  /** Human-readable label shown in logs */
  label: string;
};

export type RexResponseCallback = (
  event: AgentEvent,
  source: MessageSource
) => void;

class Rex {
  private agent: Agent | null = null;
  private listeners = new Map<string, RexResponseCallback>();
  private queue: Array<{ content: string; source: MessageSource }> = [];
  private busy = false;

  async init(): Promise<void> {
    if (this.agent) return;
    const context = await loadWorkspaceContext(AGENTBOX_DIR);
    this.agent = createAgent(context.systemPrompt);
    console.log(`[Rex] Initialized — ${this.agent.state.model.id}`);
  }

  get instance(): Agent {
    if (!this.agent) throw new Error("Rex not initialized — call rex.init() first");
    return this.agent;
  }

  /**
   * Subscribe to all agent events, tagged with the originating source.
   * Returns an unsubscribe function.
   */
  subscribe(id: string, callback: RexResponseCallback): () => void {
    this.listeners.set(id, callback);
    return () => this.listeners.delete(id);
  }

  /**
   * Send a message to Rex from a given source.
   * Queues if Rex is currently busy so concurrent connections don't clobber each other.
   */
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
      const unsubscribe = agent.subscribe((event: AgentEvent) => {
        // Broadcast to all listeners, tagged with originating source
        for (const cb of this.listeners.values()) {
          cb(event, source);
        }

        if (event.type === "agent_end") {
          unsubscribe();
          resolve();
        }
      });

      agent.prompt(content).catch(err => {
        unsubscribe();
        reject(err);
      });
    });
  }

  abort(): void {
    this.agent?.abort();
  }

  clearMessages(): void {
    this.agent?.clearMessages();
  }

  setModel(modelId: string): void {
    this.agent?.setModel({ ...DEFAULT_MODEL, id: modelId });
  }

  setThinkingLevel(level: "off" | "low" | "medium" | "high"): void {
    this.agent?.setThinkingLevel(level);
  }
}

// Singleton export
export const rex = new Rex();
