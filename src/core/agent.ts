/**
 * AgentBox agent — powered by Claude Code CLI subprocess.
 *
 * The "SDK" is the claude CLI in headless mode:
 *   claude --print --output-format=stream-json --verbose [--resume <session_id>]
 *
 * Stdin receives the user prompt. Stdout emits newline-delimited JSON events.
 * Session history lives in Claude Code's own storage — we just track the session ID.
 *
 * What this replaces vs the old agent.ts:
 *   - pi-agent-core Agent class → gone (subprocess instead)
 *   - All tool implementations (shell, read, write, list) → Claude Code's built-in tools
 *   - All compaction logic (Gemini, trimToLimit, countContextChars) → Claude Code handles it
 *   - resolveModel() / getModels() → Claude Code picks the model
 *   - getApiKey() / credentials.json → Claude Code handles auth natively
 */

import { spawn } from "child_process";
import { readFile, writeFile, unlink, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { homedir, platform } from "os";
import { fileURLToPath } from "url";

// ── Event types ───────────────────────────────────────────────────────────────

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; name: string }
  | { type: "tool_end"; name: string }
  | { type: "done"; sessionId: string }
  | { type: "error"; message: string };

// ── Raw Claude Code message shapes (from stream-json output) ──────────────────

interface CCAssistantMessage {
  type: "assistant";
  session_id: string;
  message: {
    content: Array<
      | { type: "text"; text: string }
      | { type: "tool_use"; name: string; id: string }
    >;
  };
}

interface CCToolResultMessage {
  type: "tool_result";
  session_id: string;
  tool_name?: string;
}

interface CCResultMessage {
  type: "result";
  session_id: string;
  subtype: "success" | "error";
  result: string;
  is_error: boolean;
}

type CCMessage =
  | CCAssistantMessage
  | CCToolResultMessage
  | CCResultMessage
  | { type: string; session_id?: string; [key: string]: unknown };

// ── Claude binary resolution ──────────────────────────────────────────────────

let _claudeBin: string | null = null;

/**
 * Find the claude binary.
 * Priority:
 *   1. node_modules/.bin/claude (local to agentbox repo)
 *   2. `claude` on PATH
 *   3. `npx @anthropic-ai/claude-code` as fallback
 */
async function findClaudeBin(): Promise<string> {
  if (_claudeBin) return _claudeBin;

  // 1. Check local node_modules/.bin/claude (reliable, doesn't need PATH)
  const thisFile = fileURLToPath(import.meta.url);
  // Walk up from src/core/ → src/ → repo root
  const repoRoot = join(dirname(thisFile), "..", "..");
  const localBin = join(repoRoot, "node_modules", ".bin", "claude");

  try {
    await readFile(localBin); // just check it exists
    _claudeBin = localBin;
    return _claudeBin;
  } catch {}

  // 2. Try PATH
  try {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync("which", ["claude"]);
    _claudeBin = stdout.trim();
    return _claudeBin;
  } catch {}

  // 3. npx fallback (slow but works)
  _claudeBin = "npx";
  return _claudeBin;
}

// ── Core run function ─────────────────────────────────────────────────────────

/**
 * Run one turn with the Claude Code agent.
 *
 * Spawns `claude --print --output-format=stream-json --verbose`, writes
 * the prompt to stdin, then parses the newline-delimited JSON event stream.
 *
 * Pass sessionId to resume an existing session (replaces checkpoint.ts entirely).
 * The done event carries the session ID so callers can persist it.
 *
 * NOTE: events are buffered (not true streaming). This is fine for Telegram
 * which edits the message every ~1s anyway. True streaming can be added later
 * with an async queue if we need it.
 */
export async function* runTurn(
  prompt: string,
  options: {
    sessionId?: string;
    systemPrompt?: string;
    model?: string;
    cwd?: string;
  } = {}
): AsyncGenerator<AgentEvent> {
  const { sessionId, systemPrompt, model, cwd } = options;
  const claudeBin = await findClaudeBin();

  const args = [
    "--print",
    "--output-format=stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
  ];

  if (sessionId) {
    args.push("--resume", sessionId);
  } else if (systemPrompt) {
    args.push("--system-prompt", systemPrompt);
  }

  if (model) {
    args.push("--model", model);
  }

  // If we're using npx, prepend the package name
  const spawnCmd = claudeBin === "npx" ? "npx" : claudeBin;
  const spawnArgs = claudeBin === "npx"
    ? ["@anthropic-ai/claude-code", ...args]
    : args;

  const proc = spawn(spawnCmd, spawnArgs, {
    cwd: cwd ?? process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  // Write prompt and close stdin
  proc.stdin.write(prompt);
  proc.stdin.end();

  // Collect events + stderr while subprocess runs
  let resolvedSessionId = sessionId ?? "";
  let stdoutBuf = "";
  let stderrBuf = "";
  const eventQueue: AgentEvent[] = [];
  const activeToolNames: string[] = [];

  proc.stderr.on("data", (chunk: Buffer) => { stderrBuf += chunk.toString(); });

  proc.stdout.on("data", (chunk: Buffer) => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split("\n");
    stdoutBuf = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg: CCMessage = JSON.parse(trimmed);
        if (msg.session_id) resolvedSessionId = msg.session_id;
        for (const event of translateMessage(msg, activeToolNames)) {
          eventQueue.push(event);
        }
      } catch {
        // Non-JSON line — ignore
      }
    }
  });

  // Wait for subprocess to finish
  await new Promise<void>((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0 && eventQueue.length === 0) {
        reject(new Error(
          `claude exited with code ${code}. stderr: ${stderrBuf.slice(0, 500)}`
        ));
      } else {
        resolve();
      }
    });
  });

  // Yield buffered events
  for (const event of eventQueue) {
    yield event;
  }

  yield { type: "done", sessionId: resolvedSessionId };
}

// ── Message translation ───────────────────────────────────────────────────────

function* translateMessage(msg: CCMessage, activeTools: string[]): Generator<AgentEvent> {
  switch (msg.type) {
    case "assistant": {
      const assistant = msg as CCAssistantMessage;
      for (const block of assistant.message.content) {
        if (block.type === "text" && block.text) {
          yield { type: "text_delta", text: block.text };
        } else if (block.type === "tool_use") {
          activeTools.push(block.name);
          yield { type: "tool_start", name: block.name };
        }
      }
      break;
    }

    case "tool_result": {
      const toolMsg = msg as CCToolResultMessage;
      const name = toolMsg.tool_name ?? activeTools.pop() ?? "tool";
      yield { type: "tool_end", name };
      break;
    }

    case "result": {
      const result = msg as CCResultMessage;
      if (result.is_error) {
        yield { type: "error", message: result.result };
      }
      break;
    }

    // "system", "rate_limit_event" — no UI event
  }
}

// ── Session ID persistence ────────────────────────────────────────────────────
// Replaces checkpoint.ts entirely. Session history lives in Claude Code's
// storage; we just track the ID as a plain text file.

function sessionPath(agentName: string): string {
  return join(homedir(), ".agentbox", agentName, "session_id");
}

export async function saveSessionId(agentName: string, sessionId: string): Promise<void> {
  const path = sessionPath(agentName);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, sessionId, "utf-8");
}

export async function loadSessionId(agentName: string): Promise<string | null> {
  try {
    const id = await readFile(sessionPath(agentName), "utf-8");
    return id.trim() || null;
  } catch {
    return null;
  }
}

export async function clearSessionId(agentName: string): Promise<void> {
  try {
    await unlink(sessionPath(agentName));
  } catch {}
}
