/**
 * AgentBox agent using Claude Agent SDK.
 * Wraps query() from @anthropic-ai/claude-agent-sdk for streaming interaction.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "agent_end"; result: string };

export type AgentEventCallback = (event: AgentEvent) => void;

export const DEFAULT_MODEL_ID = "claude-sonnet-4-6";

/**
 * Run an agent prompt via the Claude Agent SDK.
 * Streams events via onEvent callback. Returns final result + session ID.
 */
export async function runAgent(opts: {
  prompt: string;
  systemPrompt: string;
  sessionId?: string;
  cwd?: string;
  model?: string;
  onEvent?: AgentEventCallback;
  abortSignal?: AbortSignal;
}): Promise<{ result: string; sessionId?: string }> {
  let sessionId: string | undefined;
  let result = "";

  const queryOptions: Record<string, unknown> = {
    systemPrompt: opts.systemPrompt,
    cwd: opts.cwd ?? process.cwd(),
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
  };

  if (opts.sessionId) {
    queryOptions.resume = opts.sessionId;
  }

  if (opts.model) {
    queryOptions.model = opts.model;
  }

  for await (const message of query({
    prompt: opts.prompt,
    options: queryOptions as any,
  })) {
    if (opts.abortSignal?.aborted) break;

    const msg = message as Record<string, any>;

    // Capture session ID from init message
    if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
      sessionId = msg.session_id;
    }

    // Stream assistant text as it arrives
    if (msg.type === "assistant") {
      let text = "";
      if (typeof msg.content === "string") {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        text = msg.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text ?? "")
          .join("");
      }
      if (text) {
        opts.onEvent?.({ type: "text_delta", text });
      }
    }

    // Final result
    if ("result" in msg) {
      result = String(msg.result ?? "");
      opts.onEvent?.({ type: "agent_end", result });
    }
  }

  return { result, sessionId };
}
