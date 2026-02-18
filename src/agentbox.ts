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

export type MessageSource = {
  /** Unique ID for routing replies back — e.g. telegram:123456, tui:local */
  id: string;
  /** Human-readable label shown in logs */
  label: string;
};

export type AgentResponseCallback = (event: AgentEvent, source: MessageSource) => void;

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
    this.agent = createAgent(systemPrompt, config.model);
    console.log(`[AgentBox] ${this._name} initialized — ${this.agent.state.model.id}`);
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
      const unsubscribe = agent.subscribe((event: AgentEvent) => {
        for (const cb of this.listeners.values()) cb(event, source);
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

  abort(): void { this.agent?.abort(); }
  clearMessages(): void { this.agent?.clearMessages(); }
  setModel(modelId: string): void { this.agent?.setModel({ ...this.instance.state.model, id: modelId }); }
  setThinkingLevel(level: "off" | "low" | "medium" | "high"): void { this.agent?.setThinkingLevel(level); }

  /**
   * Signal that a real user message has arrived.
   * Called by connection adapters so the memory module can reset its idle timer.
   * The memory module registers its handler via onActivity().
   */
  markActivity(): void {
    for (const cb of this._activityListeners) cb();
  }

  private _activityListeners: Array<() => void> = [];

  /** Register a callback that fires on every markActivity() call. Returns unsubscribe fn. */
  onActivity(cb: () => void): () => void {
    this._activityListeners.push(cb);
    return () => { this._activityListeners = this._activityListeners.filter(l => l !== cb); };
  }
}

// Singleton export
export const agentbox = new AgentBox();
