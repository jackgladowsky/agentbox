/**
 * Memory write-back module.
 *
 * Detects conversation idle periods and triggers Rex to reflect on the session
 * and persist notes to rex-config. Completely silent from the user's perspective.
 *
 * Flow:
 *   1. markActivity() is called on every incoming user message.
 *   2. After idleMinutes of silence, a write-back prompt fires once.
 *   3. A /tmp marker prevents re-triggering across restarts.
 *   4. When a new user message arrives, the idle flag resets.
 */

import { readFile, writeFile, access } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { agentbox, type MessageSource } from "./agentbox.js";
import { getAgentName, agentDir, notesDir } from "./config.js";

// ── Config ─────────────────────────────────────────────────────────────────────

export interface MemoryConfig {
  /** Minutes of idle before triggering write-back (default: 10) */
  idleMinutes: number;
  /** Whether write-back is enabled at all (default: true) */
  enabled: boolean;
  /** Whether to log to console when save completes (default: false) */
  notifyOnSave: boolean;
}

const DEFAULT_CONFIG: MemoryConfig = {
  idleMinutes: 10,
  enabled: true,
  notifyOnSave: false,
};

async function loadMemoryConfig(): Promise<MemoryConfig> {
  const configPath = join(agentDir(), "memory-config.json");
  try {
    const raw = await readFile(configPath, "utf-8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

// ── Marker helpers ─────────────────────────────────────────────────────────────

function todayString(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function markerPath(): string {
  const agentName = getAgentName();
  return `/tmp/agentbox-memory-${agentName}-${todayString()}`;
}

async function isSavedToday(): Promise<boolean> {
  try {
    await access(markerPath());
    return true;
  } catch {
    return false;
  }
}

async function markSavedToday(): Promise<void> {
  await writeFile(markerPath(), new Date().toISOString(), "utf-8");
}

// ── Write-back prompt ──────────────────────────────────────────────────────────

function buildWriteBackPrompt(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toTimeString().slice(0, 5); // HH:MM

  const memoryFile = join(agentDir(), "memory", `${date}.md`);
  const notes = notesDir();
  const dir = agentDir();

  return (
    `[SYSTEM: Session idle. Reflect on this conversation and update your persistent memory.\n` +
    `1. Write/append a summary to ${memoryFile} using the format:\n` +
    `   # Memory — ${date}\n\n   ## Session: ${time}\n   <your summary here>\n` +
    `2. Update any relevant notes in ${notes}/ if you learned something new\n` +
    `3. Run: cd ${dir} && git add -A && git commit -m "memory: session summary $(date)" && git push\n` +
    `Do this silently — do NOT send a Telegram message.]`
  );
}

// ── Internal source used for write-back prompts ────────────────────────────────

const MEMORY_SOURCE: MessageSource = {
  id: "memory:internal",
  label: "memory write-back (internal)",
  internal: true,
};

// ── MemoryModule ───────────────────────────────────────────────────────────────

class MemoryModule {
  private config: MemoryConfig = DEFAULT_CONFIG;
  private idleTimer: NodeJS.Timeout | null = null;
  private firedThisIdlePeriod = false;

  async init(): Promise<void> {
    this.config = await loadMemoryConfig();
    if (!this.config.enabled) {
      console.log("[Memory] Write-back disabled via config.");
      return;
    }
    console.log(`[Memory] Idle write-back enabled — fires after ${this.config.idleMinutes}m of silence.`);

    // Hook into agentbox activity events so we reset the timer on every real user message.
    agentbox.onActivity(() => this._onUserActivity());

    this._scheduleIdleCheck();
  }

  /** Called by agentbox whenever a real user message arrives. */
  private _onUserActivity(): void {
    this.firedThisIdlePeriod = false;
    this._scheduleIdleCheck();
  }

  private _scheduleIdleCheck(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!this.config.enabled) return;

    const ms = this.config.idleMinutes * 60 * 1000;
    this.idleTimer = setTimeout(() => this._onIdle(), ms);
  }

  private async _onIdle(): Promise<void> {
    if (this.firedThisIdlePeriod) return;

    // Don't re-trigger if we already saved a write-back today (e.g. after a restart).
    if (await isSavedToday()) {
      console.log("[Memory] Already saved today — skipping write-back.");
      return;
    }

    this.firedThisIdlePeriod = true;
    console.log("[Memory] Session idle — triggering write-back.");

    try {
      await agentbox.prompt(buildWriteBackPrompt(), MEMORY_SOURCE);
      await markSavedToday();
      if (this.config.notifyOnSave) {
        console.log("[Memory] Write-back complete.");
      }
    } catch (err) {
      // Don't crash; log and move on.
      console.error("[Memory] Write-back failed:", err);
    }
  }
}

// Singleton
export const memory = new MemoryModule();
