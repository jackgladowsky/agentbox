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
const COMPACTION_MODEL_ID = "claude-haiku-4-5";

// ── Context compaction ────────────────────────────────────────────────────────

// Trigger compaction when history exceeds ~400K chars (~100K tokens).
// Tool results (especially shell output) can be huge — we count everything.
const MAX_CONTEXT_CHARS = 400_000;

// Max chars of serialized transcript we'll send to haiku for summarization.
// Haiku has a 200K token limit; ~800K chars is a safe ceiling.
const MAX_TRANSCRIPT_CHARS = 800_000;

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
 * Truncates tool results to keep the haiku prompt sane.
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
          lines.push(`[tool result]: ${resultText.slice(0, 300)}`);
        }
      }
    } else if (typeof msg.content === "string") {
      lines.push(`[${role}]: ${msg.content}`);
    }
  }
  return lines.join("\n");
}

/**
 * Call haiku to summarize the full conversation history.
 */
async function summarizeWithHaiku(transcript: string): Promise<string> {
  const apiKey = (await getApiKey("anthropic")) ?? undefined;
  const model = getModels("anthropic" as KnownProvider).find(m => m.id === COMPACTION_MODEL_ID);
  if (!model) throw new Error(`Compaction model not found: ${COMPACTION_MODEL_ID}`);

  // Guard: truncate transcript so we don't blow up haiku's own context limit.
  // Take the tail (most recent) since that's more useful than the beginning.
  const safeTranscript = transcript.length > MAX_TRANSCRIPT_CHARS
    ? `[...earlier history truncated...]\n\n${transcript.slice(-MAX_TRANSCRIPT_CHARS)}`
    : transcript;

  const systemPrompt =
    "You are a conversation summarizer. Produce a concise but complete summary of the conversation below. " +
    "Preserve: key decisions made, important facts learned, tasks completed, current goals, and any unresolved questions. " +
    "Be factual and dense. No preamble.";

  const userMessage: UserMessage = {
    role: "user",
    content: `Summarize this conversation:\n\n${safeTranscript}`,
    timestamp: Date.now(),
  };

  const eventStream = streamSimple(model, { systemPrompt, messages: [userMessage] }, { apiKey });

  let summary = "";
  for await (const event of eventStream) {
    if (event.type === "text_delta") {
      summary += event.delta;
    }
  }

  const trimmed = summary.trim();
  if (!trimmed) throw new Error("Haiku returned empty summary");
  return trimmed;
}

/**
 * When context exceeds the limit, summarize the entire history with Haiku
 * and return ONLY the summary message — no tail, no recent messages.
 *
 * Keeping a tail is unsafe: if those messages alone exceed the token limit
 * (e.g. a few giant shell outputs), we blow up immediately after compaction.
 *
 * Result after compaction:
 *   [system prompt]           (unchanged, handled by agent)
 *   [CONTEXT_COMPACTED ...]   (single summary message, that's it)
 *
 * Stored history is untouched — only what gets sent to the API changes.
 *
 * IMPORTANT: On any failure, we return [] (empty history) rather than a
 * partial slice. A partial slice can itself exceed the limit, causing an
 * infinite compaction loop. Empty history is safe — the agent just loses
 * context but keeps running.
 */
async function compactContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
  const charCount = countContextChars(messages);
  if (charCount <= MAX_CONTEXT_CHARS) return messages;

  console.log(`[AgentBox] Context limit hit (${charCount} chars) — compacting with ${COMPACTION_MODEL_ID}...`);

  let summary: string;
  try {
    summary = await summarizeWithHaiku(serializeMessages(messages));
  } catch (err: any) {
    console.error(`[AgentBox] Compaction failed: ${err.message} — clearing history to avoid loop`);
    // Return empty array, NOT messages.slice(-1). A partial slice can still
    // exceed the limit and cause an infinite compaction loop.
    return [];
  }

  const summaryMessage: UserMessage = {
    role: "user",
    content: `${COMPACTION_CODE}\n\n${summary}`,
    timestamp: Date.now(),
  };

  console.log(`[AgentBox] Compacted ${messages.length} messages → 1 summary (${summary.length} chars).`);

  // Return ONLY the summary — no tail. A tail of recent messages can itself
  // exceed the token limit if it contains large tool outputs.
  return [summaryMessage];
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
 */
export function createAgent(systemPrompt: string, modelId?: string): Agent {
  const agent = new Agent({
    initialState: {
      systemPrompt: systemPrompt + COMPACTION_SYSTEM_INSTRUCTION,
      model: resolveModel(modelId),
      thinkingLevel: "off",
      tools: getTools(),
    },
    transformContext: compactContext,
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

// Max bytes returned by any single tool call.
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
