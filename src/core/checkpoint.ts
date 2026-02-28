/**
 * Session persistence — maintains conversation continuity across restarts.
 *
 * The Claude Agent SDK manages conversation state via session IDs.
 * We persist the session ID to disk so restarts resume the last session.
 *
 * File: ~/.agentbox/<agent>/session.json
 */

import { readFile, writeFile, unlink, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { agentDir } from "./config.js";

interface SessionData {
  sessionId: string;
  savedAt: number;
}

function sessionPath(): string {
  return join(agentDir(), "session.json");
}

export async function saveSession(sessionId: string): Promise<void> {
  const data: SessionData = { sessionId, savedAt: Date.now() };
  const path = sessionPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data), "utf-8");
  console.log(`[Session] Saved: ${sessionId}`);
}

export async function loadSession(): Promise<string | null> {
  try {
    const raw = await readFile(sessionPath(), "utf-8");
    const data: SessionData = JSON.parse(raw);
    console.log(`[Session] Loaded: ${data.sessionId}`);
    return data.sessionId;
  } catch {
    return null;
  }
}

export async function clearSession(): Promise<void> {
  try {
    await unlink(sessionPath());
    console.log("[Session] Cleared.");
  } catch {
    // Doesn't exist — fine
  }
}
