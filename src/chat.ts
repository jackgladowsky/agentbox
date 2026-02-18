import Anthropic from "@anthropic-ai/sdk";
import type { AuthToken } from "./credentials.js";

const CLAUDE_CODE_VERSION = "2.1.2";

export interface Message {
  role: "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  model?: string;
  maxTokens?: number;
  systemPrompt?: string;
}

/**
 * Create an Anthropic client configured for Claude Code OAuth
 */
export function createClient(auth: AuthToken): Anthropic {
  return new Anthropic({
    apiKey: "", // Not used with OAuth
    authToken: auth.token,
    defaultHeaders: {
      "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
      "user-agent": `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`,
      "x-app": "cli",
    },
  });
}

/**
 * Send a message and stream the response
 */
export async function chat(
  client: Anthropic,
  messages: Message[],
  options: ChatOptions = {},
  onDelta?: (text: string) => void
): Promise<string> {
  const model = options.model || "claude-sonnet-4-20250514";
  const maxTokens = options.maxTokens || 8192;

  const systemMessages: Anthropic.TextBlockParam[] = [
    {
      type: "text",
      text: "You are Claude Code, Anthropic's official CLI for Claude.",
    },
  ];

  if (options.systemPrompt) {
    systemMessages.push({
      type: "text",
      text: options.systemPrompt,
    });
  }

  const stream = client.messages.stream({
    model,
    max_tokens: maxTokens,
    system: systemMessages,
    messages: messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
  });

  let fullResponse = "";

  for await (const event of stream) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      const text = event.delta.text;
      fullResponse += text;
      onDelta?.(text);
    }
  }

  return fullResponse;
}
