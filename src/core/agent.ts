/**
 * AgentBox agent using pi-agent-core.
 * Provides tool execution, streaming, and state management.
 */
import { Agent, type AgentTool, type AgentMessage } from "@mariozechner/pi-agent-core";
import {
  getModels,
  registerBuiltInApiProviders,
  streamSimple,
  Type,
  type KnownProvider,
  type UserMessage,
} from "@mariozechner/pi-ai";
import { getApiKey } from "./auth.js";
import { exec } from "child_process";
import { promisify } from "util";
import { readFile, writeFile, readdir, stat, mkdir } from "fs/promises";
import { join, dirname } from "path";

const execAsync = promisify(exec);

// Register all built-in providers (Anthropic, OpenAI, Google, etc.)
registerBuiltInApiProviders();

export const DEFAULT_MODEL_ID = "claude-sonnet-4-6";

// ── Context compaction ────────────────────────────────────────────────────────

// Trigger compaction when history exceeds ~400K chars (~100K tokens).
// Tool results (especially shell output) can be huge — we count everything.
const MAX_CONTEXT_CHARS = 400_000;

// Primary compaction model: Gemini 2.5 Flash Lite via OpenRouter.
// 1M context window — we can dump the entire transcript without truncation.
const COMPACTION_MODEL_ID = "google/gemini-2.5-flash-lite";
const COMPACTION_PROVIDER = "openrouter";

/**
 * Marker prepended to compaction summary messages.
 * The system prompt instructs the agent to recognize this and keep moving.
 */
export const COMPACTION_CODE = "[CONTEXT_COMPACTED]";

/**
 * Standing instruction appended to every agent's system prompt.
 * Tells the agent what to do when it wakes up into a compacted context.
 */
const COMPACTION_SYSTEM_INSTRUCTION = `

---
When you encounter a message beginning with "${COMPACTION_CODE}", your conversation history was automatically summarized due to context length. The message contains a summary of everything that happened before. Acknowledge this briefly in one sentence (e.g. "Got it, resuming from summary."), then continue with whatever was being worked on without asking for clarification.`;

/**
 * Count all text content in the message history, including tool results.
 * Previous version missed tool_result content which is the biggest source of bloat
 * (shell output, file reads, etc. can each be megabytes).
 */
function countContextChars(messages: AgentMessage[]): number {
  let total = 0;
  for (const msg of messages as any[]) {
    if (Array.isArray(msg.content)) {
      for (const c of msg.content) {
        // Text, thinking, partial JSON from assistant turns
        if (typeof c.text === "string") total += c.text.length;
        if (typeof c.thinking === "string") total += c.thinking.length;
        if (typeof c.partialJson === "string") total += c.partialJson.length;
        // Tool call inputs
        if (c.type === "tool_use" && c.input) {
          total += JSON.stringify(c.input).length;
        }
        // Tool results — this is where the real bloat lives (shell output, file reads, etc.)
        if (c.type === "tool_result") {
          if (Array.isArray(c.content)) {
            for (const r of c.content) {
              if (typeof r.text === "string") total += r.text.length;
            }
          } else if (typeof c.content === "string") {
            total += c.content.length;
          }
        }
      }
    } else if (typeof msg.content === "string") {
      total += msg.content.length;
    }
  }
  return total;
}

/**
 * Serialize messages to plain text for summarization.
 * Produces a readable transcript of the full conversation.
 */
function serializeMessages(messages: AgentMessage[]): string {
  const lines: string[] = [];
  for (const msg of messages as any[]) {
    const role: string = msg.role ?? "unknown";
    if (Array.isArray(msg.content)) {
      for (const c of msg.content) {
        if (typeof c.text === "string") {
          lines.push(`[${role}]: ${c.text}`);
        } else if (c.type === "tool_use") {
          lines.push(`[${role} tool call: ${c.name}]: ${JSON.stringify(c.input ?? {}).slice(0, 200)}`);
        } else if (c.type === "tool_result") {
          const resultText = Array.isArray(c.content)
            ? c.content.map((x: any) => x.text ?? "").join(" ")
            : String(c.content ?? "");
          lines.push(`[tool result]: ${resultText.slice(0, 500)}`);
        }
      }
    } else if (typeof msg.content === "string") {
      lines.push(`[${role}]: ${msg.content}`);
    }
  }
  return lines.join("\n");
}

/**
 * Summarize the full conversation transcript using Gemini 2.5 Flash Lite via OpenRouter.
 * 1M context window — no truncation needed, we send the whole thing.
 */
async function summarizeWithGemini(transcript: string, openrouterKey: string): Promise<string> {
  const model = getModels(COMPACTION_PROVIDER as KnownProvider).find(m => m.id === COMPACTION_MODEL_ID);
  if (!model) throw new Error(`Compaction model not found: ${COMPACTION_PROVIDER}/${COMPACTION_MODEL_ID}`);

  const systemPrompt =
    "You are a conversation summarizer. Produce a concise but complete summary of the conversation below. " +
    "Preserve: key decisions made, important facts learned, tasks completed, current goals, and any unresolved questions. " +
    "Be factual and dense. No preamble.";

  const userMessage: UserMessage = {
    role: "user",
    content: `Summarize this conversation:\n\n${transcript}`,
    timestamp: Date.now(),
  };

  const eventStream = streamSimple(model, { systemPrompt, messages: [userMessage] }, { apiKey: openrouterKey });

  let summary = "";
  for await (const event of eventStream) {
    if (event.type === "text_delta") {
      summary += event.delta;
    }
  }

  const trimmed = summary.trim();
  if (!trimmed) throw new Error("Gemini returned empty summary");
  return trimmed;
}

/**
 * Safe fallback when AI summarization fails.
 * Drops oldest messages until we're under the limit.
 * Guarantees no infinite loop — worst case we keep just the last message.
 */
function trimToLimit(messages: AgentMessage[]): AgentMessage[] {
  let trimmed = messages.slice();
  while (trimmed.length > 1 && countContextChars(trimmed) > MAX_CONTEXT_CHARS) {
    trimmed = trimmed.slice(1);
  }
  console.log(`[AgentBox] Fallback trim: kept ${trimmed.length}/${messages.length} messages.`);
  return trimmed;
}

/**
 * When context exceeds the limit, summarize the entire history with Gemini 2.5 Flash Lite
 * and return ONLY the summary message — no tail, no recent messages.
 *
 * IMPORTANT: transformContext in pi-agent-core only transforms what's sent to the API.
 * It does NOT update agent.state.messages (the stored history). To prevent an infinite
 * compaction loop, we must also write the compacted result back into agent.state.messages
 * via the writeBack callback. Without this, every subsequent turn would re-trigger
 * compaction immediately since the stored history never shrinks.
 *
 * Result after compaction:
 *   [system prompt]           (unchanged, handled by agent)
 *   [CONTEXT_COMPACTED ...]   (single summary message, that's it)
 *
 * On failure: trimToLimit() drops oldest messages until under the limit.
 * This is always safe — no infinite loop possible.
 */
async function compactContext(
  messages: AgentMessage[],
  openrouterKey: string | undefined,
  writeBack: (compacted: AgentMessage[]) => void,
): Promise<AgentMessage[]> {
  const charCount = countContextChars(messages);
  if (charCount <= MAX_CONTEXT_CHARS) return messages;

  console.log(`[AgentBox] Context limit hit (${charCount} chars) — compacting with ${COMPACTION_PROVIDER}/${COMPACTION_MODEL_ID}...`);

  if (!openrouterKey) {
    console.warn("[AgentBox] No OpenRouter key configured — falling back to trim.");
    const trimmed = trimToLimit(messages);
    writeBack(trimmed);
    return trimmed;
  }

  let summary: string;
  try {
    summary = await summarizeWithGemini(serializeMessages(messages), openrouterKey);
  } catch (err: any) {
    console.error(`[AgentBox] Compaction failed: ${err.message} — falling back to trim.`);
    const trimmed = trimToLimit(messages);
    writeBack(trimmed);
    return trimmed;
  }

  const summaryMessage: UserMessage = {
    role: "user",
    content: `${COMPACTION_CODE}\n\n${summary}`,
    timestamp: Date.now(),
  };

  const compacted = [summaryMessage];

  // Write back to stored history so future turns don't re-trigger compaction immediately.
  writeBack(compacted);

  console.log(`[AgentBox] Compacted ${messages.length} messages → 1 summary (${summary.length} chars).`);

  return compacted;
}

export function resolveModel(modelId?: string) {
  const id = modelId ?? DEFAULT_MODEL_ID;
  const model = getModels("anthropic" as KnownProvider).find(m => m.id === id);
  if (!model) throw new Error(`Unknown model: ${id}`);
  return model;
}

/**
 * Create an AgentBox agent with the standard tool set.
 * Automatically appends the compaction instruction to the system prompt.
 * Pass openrouterKey to enable AI-powered compaction (Gemini 2.5 Flash Lite).
 * Without it, compaction falls back to trimming oldest messages.
 */
export function createAgent(systemPrompt: string, modelId?: string, openrouterKey?: string): Agent {
  const agent = new Agent({
    initialState: {
      systemPrompt: systemPrompt + COMPACTION_SYSTEM_INSTRUCTION,
      model: resolveModel(modelId),
      thinkingLevel: "off",
      tools: getTools(),
    },
    transformContext: (messages) =>
      compactContext(messages, openrouterKey, (compacted) => {
        // Write the compacted history back into agent.state.messages.
        // pi-agent-core's transformContext only transforms the API payload — it never
        // updates stored messages. Without this write-back, the stored history keeps
        // growing and compaction fires on every single subsequent turn (infinite loop).
        agent.state.messages.splice(0, agent.state.messages.length, ...compacted);
      }),
    getApiKey: async (provider: string) => {
      if (provider === "anthropic") {
        return (await getApiKey("anthropic")) ?? undefined;
      }
      return undefined;
    },
  });

  return agent;
}

// ── Tools ─────────────────────────────────────────────────────────────────────

function getTools(): AgentTool<any>[] {
  return [shellTool, readFileTool, writeFileTool, listDirTool];
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

// Max chars returned by any single tool call.
// Prevents one giant shell output or file read from blowing up context.
const MAX_TOOL_OUTPUT_CHARS = 50_000;

function truncateOutput(output: string): string {
  if (output.length <= MAX_TOOL_OUTPUT_CHARS) return output;
  const kept = MAX_TOOL_OUTPUT_CHARS;
  const dropped = output.length - kept;
  return output.slice(0, kept) + `\n\n[... ${dropped} chars truncated ...]`;
}

const ShellParams = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
  workdir: Type.Optional(Type.String({ description: "Working directory" })),
  timeout: Type.Optional(Type.Number({ description: "Timeout in ms (default: 30000)" })),
});

const shellTool: AgentTool<typeof ShellParams> = {
  name: "shell",
  label: "Execute Shell Command",
  description: "Execute a shell command and return stdout/stderr. Use for system operations, running scripts, etc.",
  parameters: ShellParams,
  execute: async (_id, params) => {
    const { command, workdir, timeout = 30000 } = params;
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: workdir,
        timeout,
        maxBuffer: 10 * 1024 * 1024,
      });
      const output = [stdout, stderr].filter(Boolean).join("\n---stderr---\n") || "(no output)";
      return ok(truncateOutput(output));
    } catch (err: any) {
      const output = `Error: ${[err.stdout, err.stderr, err.message].filter(Boolean).join("\n")}`;
      return ok(truncateOutput(output));
    }
  },
};

const ReadFileParams = Type.Object({
  path: Type.String({ description: "Path to the file to read" }),
  encoding: Type.Optional(Type.String({ description: "Encoding (default: utf-8)" })),
});

const readFileTool: AgentTool<typeof ReadFileParams> = {
  name: "read_file",
  label: "Read File",
  description: "Read the contents of a file.",
  parameters: ReadFileParams,
  execute: async (_id, params) => {
    const { path, encoding = "utf-8" } = params;
    try {
      const content = await readFile(path, encoding as BufferEncoding);
      return ok(truncateOutput(content));
    } catch (err: any) {
      return ok(`Error reading file: ${err.message}`);
    }
  },
};

const WriteFileParams = Type.Object({
  path: Type.String({ description: "Path to write to" }),
  content: Type.String({ description: "Content to write" }),
  createDirs: Type.Optional(Type.Boolean({ description: "Create parent directories if needed" })),
});

const writeFileTool: AgentTool<typeof WriteFileParams> = {
  name: "write_file",
  label: "Write File",
  description: "Write content to a file. Creates the file if it doesn't exist.",
  parameters: WriteFileParams,
  execute: async (_id, params) => {
    const { path, content, createDirs = true } = params;
    try {
      if (createDirs) await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf-8");
      return ok(`Wrote ${content.length} bytes to ${path}`);
    } catch (err: any) {
      return ok(`Error writing file: ${err.message}`);
    }
  },
};

const ListDirParams = Type.Object({
  path: Type.String({ description: "Directory path to list" }),
  recursive: Type.Optional(Type.Boolean({ description: "List recursively" })),
});

const listDirTool: AgentTool<typeof ListDirParams> = {
  name: "list_dir",
  label: "List Directory",
  description: "List files and directories in a path.",
  parameters: ListDirParams,
  execute: async (_id, params) => {
    const { path, recursive = false } = params;
    try {
      return ok((await listDirectory(path, recursive)).join("\n") || "(empty)");
    } catch (err: any) {
      return ok(`Error listing directory: ${err.message}`);
    }
  },
};

async function listDirectory(dir: string, recursive: boolean, prefix = ""): Promise<string[]> {
  const entries = await readdir(dir);
  const results: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stats = await stat(fullPath);
    const displayPath = prefix + entry;
    if (stats.isDirectory()) {
      results.push(displayPath + "/");
      if (recursive) results.push(...await listDirectory(fullPath, true, displayPath + "/"));
    } else {
      results.push(displayPath);
    }
  }
  return results;
}
