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

// Trigger compaction when history exceeds ~400K chars (~100K tokens)
const MAX_CONTEXT_CHARS = 400_000;
// Keep this many recent messages raw after compaction for recency/detail
const RECENT_MESSAGES_TO_KEEP = 10;

function countContextChars(messages: AgentMessage[]): number {
  let total = 0;
  for (const msg of messages as any[]) {
    if (Array.isArray(msg.content)) {
      for (const c of msg.content) {
        if (typeof c.text === "string") total += c.text.length;
        if (typeof c.thinking === "string") total += c.thinking.length;
        if (typeof c.partialJson === "string") total += c.partialJson.length;
      }
    } else if (typeof msg.content === "string") {
      total += msg.content.length;
    }
  }
  return total;
}

/**
 * Serialize messages to plain text for summarization.
 * Strips tool call internals down to readable form.
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
 * Call haiku to summarize the old portion of conversation history.
 */
async function summarizeWithHaiku(transcript: string): Promise<string> {
  const apiKey = (await getApiKey("anthropic")) ?? undefined;
  const model = getModels("anthropic" as KnownProvider).find(m => m.id === COMPACTION_MODEL_ID);
  if (!model) throw new Error(`Compaction model not found: ${COMPACTION_MODEL_ID}`);

  const systemPrompt =
    "You are a conversation summarizer. Produce a concise but complete summary of the conversation below. " +
    "Preserve: key decisions made, important facts learned, tasks completed, current goals, and any unresolved questions. " +
    "Be factual and dense. No preamble.";

  const userMessage: UserMessage = {
    role: "user",
    content: `Summarize this conversation:\n\n${transcript}`,
    timestamp: Date.now(),
  };

  const eventStream = streamSimple(model, { systemPrompt, messages: [userMessage] }, { apiKey });

  let summary = "";
  for await (const event of eventStream) {
    if (event.type === "text_delta") {
      summary += event.delta;
    }
  }

  return summary.trim();
}

/**
 * When context exceeds the limit, summarize all but the most recent messages
 * using Haiku, then return: [summary user message, ...recent raw messages].
 * The stored agent history is untouched — only what gets sent to the API changes.
 */
async function compactContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
  if (countContextChars(messages) <= MAX_CONTEXT_CHARS) return messages;

  console.log(`[AgentBox] Context limit hit (${countContextChars(messages)} chars) — compacting with ${COMPACTION_MODEL_ID}...`);

  const splitAt = Math.max(0, messages.length - RECENT_MESSAGES_TO_KEEP);
  const toSummarize = messages.slice(0, splitAt);
  const recent = messages.slice(splitAt);

  let summary: string;
  try {
    summary = await summarizeWithHaiku(serializeMessages(toSummarize));
  } catch (err: any) {
    console.error(`[AgentBox] Compaction failed, falling back to trim: ${err.message}`);
    // Fallback: just keep recent messages if haiku call fails
    return recent;
  }

  const summaryMessage: UserMessage = {
    role: "user",
    content: `[Summary of conversation so far]\n\n${summary}`,
    timestamp: toSummarize.length > 0 ? (toSummarize[0] as any).timestamp ?? Date.now() : Date.now(),
  };

  console.log(`[AgentBox] Compacted ${toSummarize.length} messages into summary (${summary.length} chars). Keeping ${recent.length} recent messages.`);

  return [summaryMessage, ...recent];
}

export function resolveModel(modelId?: string) {
  const id = modelId ?? DEFAULT_MODEL_ID;
  const model = getModels("anthropic" as KnownProvider).find(m => m.id === id);
  if (!model) throw new Error(`Unknown model: ${id}`);
  return model;
}

/**
 * Create an AgentBox agent with the standard tool set.
 */
export function createAgent(systemPrompt: string, modelId?: string): Agent {
  const agent = new Agent({
    initialState: {
      systemPrompt,
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
      return ok([stdout, stderr].filter(Boolean).join("\n---stderr---\n") || "(no output)");
    } catch (err: any) {
      return ok(`Error: ${[err.stdout, err.stderr, err.message].filter(Boolean).join("\n")}`);
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
      return ok(await readFile(path, encoding as BufferEncoding));
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
