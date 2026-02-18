/**
 * AgentBox agent using pi-agent-core.
 * Provides tool execution, streaming, and state management.
 */
import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import { 
  getModel, 
  registerBuiltInApiProviders, 
  Type,
} from "@mariozechner/pi-ai";
import { getApiKey } from "./auth.js";
import { exec } from "child_process";
import { promisify } from "util";
import { readFile, writeFile, readdir, stat, mkdir } from "fs/promises";
import { join, dirname } from "path";

const execAsync = promisify(exec);

// Register all built-in providers (Anthropic, OpenAI, Google, etc.)
registerBuiltInApiProviders();

// Default model - use getModel for proper typing
export const DEFAULT_MODEL = getModel("anthropic", "claude-sonnet-4-20250514");

/**
 * Create the AgentBox agent with tools
 */
export function createAgent(systemPrompt: string): Agent {
  const agent = new Agent({
    initialState: {
      systemPrompt,
      model: DEFAULT_MODEL,
      thinkingLevel: "off",
      tools: getTools(),
    },
    // Resolve API key dynamically (handles token refresh)
    getApiKey: async (provider: string) => {
      if (provider === "anthropic") {
        return (await getApiKey("anthropic")) ?? undefined;
      }
      return undefined;
    },
  });

  return agent;
}

/**
 * Built-in tools for AgentBox
 */
function getTools(): AgentTool<any>[] {
  return [
    shellTool,
    readFileTool,
    writeFileTool,
    listDirTool,
  ];
}

// ============== TOOLS ==============

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
  execute: async (_toolCallId, params) => {
    const { command, workdir, timeout = 30000 } = params;
    
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: workdir,
        timeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });
      
      const output = [stdout, stderr].filter(Boolean).join("\n---stderr---\n");
      return {
        content: [{ type: "text", text: output || "(no output)" }],
        details: { exitCode: 0 },
      };
    } catch (err: any) {
      const output = [err.stdout, err.stderr, err.message].filter(Boolean).join("\n");
      return {
        content: [{ type: "text", text: `Error: ${output}` }],
        details: { exitCode: err.code ?? 1 },
      };
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
  execute: async (_toolCallId, params) => {
    const { path, encoding = "utf-8" } = params;
    
    try {
      const content = await readFile(path, encoding as BufferEncoding);
      return {
        content: [{ type: "text", text: content }],
        details: { path, size: content.length },
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Error reading file: ${err.message}` }],
        details: { error: err.message },
      };
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
  execute: async (_toolCallId, params) => {
    const { path, content, createDirs = true } = params;
    
    try {
      if (createDirs) {
        await mkdir(dirname(path), { recursive: true });
      }
      await writeFile(path, content, "utf-8");
      return {
        content: [{ type: "text", text: `Wrote ${content.length} bytes to ${path}` }],
        details: { path, size: content.length },
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Error writing file: ${err.message}` }],
        details: { error: err.message },
      };
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
  execute: async (_toolCallId, params) => {
    const { path, recursive = false } = params;
    
    try {
      const entries = await listDirectory(path, recursive);
      return {
        content: [{ type: "text", text: entries.join("\n") || "(empty)" }],
        details: { path, count: entries.length },
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Error listing directory: ${err.message}` }],
        details: { error: err.message },
      };
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
      if (recursive) {
        const subEntries = await listDirectory(fullPath, true, displayPath + "/");
        results.push(...subEntries);
      }
    } else {
      results.push(displayPath);
    }
  }
  
  return results;
}
