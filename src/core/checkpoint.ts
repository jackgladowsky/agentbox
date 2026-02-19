/**
 * Context checkpoint — persist message history across service restarts.
 *
 * On SIGTERM (e.g. /update restart), we serialize the agent's messages to disk.
 * On startup, if a recent checkpoint exists, we restore it so context survives.
 *
 * Checkpoint file: ~/.agentbox/<agent>/checkpoint.json
 * Considered "fresh" if written within MAX_CHECKPOINT_AGE_MS (2 hours by default).
 *
 * On /clear or /reset: call clearCheckpoint() to discard the saved history.
 */

import { readFile, writeFile, unlink } from "fs/promises";
import { join } from "path";
import { agentDir } from "./config.js";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

// Max age of a checkpoint before we treat it as stale and discard it.
const MAX_CHECKPOINT_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

interface Checkpoint {
  savedAt: number;
  messages: AgentMessage[];
}

function checkpointPath(): string {
  return join(agentDir(), "checkpoint.json");
}

/**
 * Save current messages to disk.
 * Called before process exit so restarts don't wipe context.
 */
export async function saveCheckpoint(messages: AgentMessage[]): Promise<void> {
  if (messages.length === 0) return;
  const checkpoint: Checkpoint = { savedAt: Date.now(), messages };
  await writeFile(checkpointPath(), JSON.stringify(checkpoint), "utf-8");
  console.log(`[Checkpoint] Saved ${messages.length} messages.`);
}

/**
 * Load a fresh checkpoint, if one exists.
 * Returns null if no checkpoint, or if it's older than MAX_CHECKPOINT_AGE_MS.
 */
export async function loadCheckpoint(): Promise<AgentMessage[] | null> {
  try {
    const raw = await readFile(checkpointPath(), "utf-8");
    const checkpoint: Checkpoint = JSON.parse(raw);
    const age = Date.now() - checkpoint.savedAt;
    if (age > MAX_CHECKPOINT_AGE_MS) {
      console.log(`[Checkpoint] Stale (${Math.round(age / 60000)}m old) — discarding.`);
      await clearCheckpoint();
      return null;
    }
    console.log(`[Checkpoint] Restored ${checkpoint.messages.length} messages (${Math.round(age / 1000)}s old).`);
    return checkpoint.messages;
  } catch {
    return null; // No checkpoint or parse error — start fresh
  }
}

/**
 * Delete the checkpoint file.
 * Call this when the user explicitly clears history (/reset, /clear, /new).
 */
export async function clearCheckpoint(): Promise<void> {
  try {
    await unlink(checkpointPath());
  } catch {
    // Doesn't exist — fine
  }
}
