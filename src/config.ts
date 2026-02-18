/**
 * Agent configuration loader.
 *
 * Each agent lives in ~/.agentbox/<agent-name>/
 *   config.json  — name, model, connection tokens, allowed users
 *   SOUL.md      — personality / system prompt
 *   notes/       — persistent memory (read by workspace.ts)
 *
 * Agent is selected via AGENT env var (default: reads config.json agentName or "agent").
 */

import { readFile, writeFile, mkdir, access } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

export const AGENTBOX_DIR = join(homedir(), ".agentbox");

export interface TelegramConfig {
  token: string;
  allowedUsers: number[];
}

export interface AgentConfig {
  /** Display name for this agent */
  name: string;
  /** Anthropic model ID */
  model?: string;
  /** Telegram connection config */
  telegram?: TelegramConfig;
}

/**
 * Get the agent name from AGENT env var, or fall back to "agent".
 */
export function getAgentName(): string {
  return process.env.AGENT ?? "agent";
}

/**
 * Path to the agent's home directory: ~/.agentbox/<name>/
 */
export function agentDir(name: string = getAgentName()): string {
  return join(AGENTBOX_DIR, name);
}

/**
 * Load config.json for the given agent.
 * Throws with a helpful message if missing.
 */
export async function loadAgentConfig(name: string = getAgentName()): Promise<AgentConfig> {
  const configPath = join(agentDir(name), "config.json");
  try {
    const raw = await readFile(configPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    throw new Error(
      `No config found for agent "${name}" at ${configPath}\n\n` +
      `Create it with:\n` +
      `  mkdir -p ~/.agentbox/${name}\n` +
      `  cat > ~/.agentbox/${name}/config.json << 'EOF'\n` +
      `  {\n` +
      `    "name": "${name}",\n` +
      `    "telegram": {\n` +
      `      "token": "YOUR_BOT_TOKEN",\n` +
      `      "allowedUsers": [YOUR_TELEGRAM_USER_ID]\n` +
      `    }\n` +
      `  }\n` +
      `  EOF`
    );
  }
}

/**
 * Load SOUL.md for the given agent (returns empty string if missing).
 */
export async function loadSoul(name: string = getAgentName()): Promise<string> {
  const soulPath = join(agentDir(name), "SOUL.md");
  try {
    return await readFile(soulPath, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Path to the agent's notes directory.
 */
export function notesDir(name: string = getAgentName()): string {
  return join(agentDir(name), "notes");
}
