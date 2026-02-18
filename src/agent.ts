/**
 * AgentBox agent using pi-agent-core.
 * Provides tool execution, streaming, and state management.
 */
import { Agent, type AgentTool, type AgentMessage } from "@mariozechner/pi-agent-core";
import {
  getModel,
  getModels,
  registerBuiltInApiProviders,
  Type,
  type KnownProvider,
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

// ── Context pruning ───────────────────────────────────────────────────────────

// ~400K chars ≈ 100K tokens, leaving headroom for system prompt + output
const MAX_CONTEXT_CHARS = 400_000;

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

async function pruneContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
  if (countContextChars(messages) <= MAX_CONTEXT_CHARS) return messages;
  const result = [...messages];
  while (result.length > 6 && countContextChars(result) > MAX_CONTEXT_CHARS) {
    result.shift();
  }
  console.log(`[AgentBox] Context pruned to ${result.length} messages`);
  return result;
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
    transformContext: pruneContext,
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
