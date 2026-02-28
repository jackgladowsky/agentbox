/**
 * AgentBox agent — powered by @anthropic-ai/claude-agent-sdk.
 *
 * query() returns an AsyncGenerator<SDKMessage> — no subprocess, no JSON parsing,
 * no binary path resolution. Just import and call.
 *
 * What this replaces vs the old agent.ts:
 *   - pi-agent-core Agent class → query() from SDK
 *   - All tool implementations → Claude Code's built-in tools
 *   - All compaction logic → Claude Code handles it natively
 *   - resolveModel() / getModels() → Options.model
 *   - getApiKey() / credentials.json → SDK uses Claude Code's existing auth
 *   - checkpoint.ts → session_id file (SDK persists history server-side)
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage, Options } from "@anthropic-ai/claude-agent-sdk";
import { readFile, writeFile, unlink, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { homedir } from "os";

// ── Event types ───────────────────────────────────────────────────────────────

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; name: string }
  | { type: "tool_end"; name: string }
  | { type: "done"; sessionId: string }
  | { type: "error"; message: string };

// ── Core run function ─────────────────────────────────────────────────────────

/**
 * Run one turn with the Claude Code agent.
 *
 * Pass sessionId to resume an existing session (replaces checkpoint.ts).
 * The done event carries the session_id so callers can persist it.
 */
export async function* runTurn(
  prompt: string,
  options: {
    sessionId?: string;
    systemPrompt?: string;
    model?: string;
    cwd?: string;
    abortController?: AbortController;
  } = {}
): AsyncGenerator<AgentEvent> {
  const { sessionId, systemPrompt, model, cwd, abortController } = options;

  const sdkOptions: Options = {
    resume: sessionId,
    model,
    cwd,
    abortController,
    allowDangerouslySkipPermissions: true,
    permissionMode: "bypassPermissions",
  };

  // System prompt only applies to new sessions
  // For existing sessions the SDK ignores it (history already has the context)
  if (systemPrompt && !sessionId) {
    sdkOptions.systemPrompt = systemPrompt;
  }

  let resolvedSessionId = sessionId ?? "";

  try {
    const stream = query({ prompt, options: sdkOptions });

    for await (const msg of stream) {
      // Capture session ID from any message that carries it
      if ("session_id" in msg && msg.session_id) {
        resolvedSessionId = msg.session_id;
      }

      yield* translateMessage(msg);
    }
  } catch (err: any) {
    yield { type: "error", message: err?.message ?? String(err) };
  }

  yield { type: "done", sessionId: resolvedSessionId };
}

// ── Message translation ───────────────────────────────────────────────────────

function* translateMessage(msg: SDKMessage): Generator<AgentEvent> {
  switch (msg.type) {
    case "assistant": {
      if (msg.error) {
        yield { type: "error", message: `API error: ${msg.error}` };
        break;
      }
      for (const block of msg.message.content) {
        if (block.type === "text" && block.text) {
          yield { type: "text_delta", text: block.text };
        } else if (block.type === "tool_use") {
          yield { type: "tool_start", name: block.name };
        }
      }
      break;
    }

    case "result": {
      if (msg.is_error) {
        yield { type: "error", message: msg.result };
      }
      // session_id captured above — done event emitted by runTurn
      break;
    }

    // tool_result, system, rate_limit_event, etc. — no UI event needed
  }
}

// ── Session ID persistence ────────────────────────────────────────────────────
// Replaces checkpoint.ts entirely.
// SDK persists session history in ~/.claude/projects/ automatically.
// We just track the session_id string so we can resume after restart.

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
