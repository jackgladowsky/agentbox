/**
 * Agent configuration loader.
 *
 * Each agent lives in ~/.agentbox/<agent-name>/
 *   config.json   — all settings including secrets (gitignore this file)
 *   SOUL.md       — personality / system prompt
 *   notes/        — persistent memory (read by workspace.ts)
 *   memory/       — daily session summaries
 *
 * Agent is selected via AGENT env var (default: "agent").
 *
 * config.json shape:
 * {
 *   "name": "Rex",
 *   "timezone": "America/New_York",
 *   "model": "claude-sonnet-4-6",          // optional
 *   "openrouterKey": "sk-or-...",           // optional, for compaction
 *   "telegram": {
 *     "token": "...",
 *     "allowedUsers": [123456789]
 *   }
 * }
 */

import { readFile } from "fs/promises";
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
  /** IANA timezone string (e.g. "America/New_York"). Defaults to system timezone. */
  timezone?: string;
  /** OpenRouter API key for compaction */
  openrouterKey?: string;
}

export function getAgentName(): string {
  return process.env.AGENT ?? "agent";
}

export function agentDir(name: string = getAgentName()): string {
  return join(AGENTBOX_DIR, name);
}

export function notesDir(name: string = getAgentName()): string {
  return join(agentDir(name), "notes");
}

export function validateAgentConfig(config: AgentConfig): string[] {
  const errors: string[] = [];

  if (!config.name || typeof config.name !== "string") {
    errors.push("config.name must be a non-empty string");
  }

  if (config.model !== undefined && (!config.model || typeof config.model !== "string")) {
    errors.push("config.model must be a non-empty string");
  }

  if (config.telegram !== undefined) {
    if (!config.telegram.token || typeof config.telegram.token !== "string") {
      errors.push("config.telegram.token must be a non-empty string");
    }
    if (
      !Array.isArray(config.telegram.allowedUsers) ||
      config.telegram.allowedUsers.length === 0
    ) {
      errors.push("config.telegram.allowedUsers must be a non-empty array of numbers");
    }
  }

  return errors;
}

/**
 * Load config.json for the given agent.
 * All settings (including secrets) live in one file — gitignore it.
 */
export async function loadAgentConfig(name: string = getAgentName()): Promise<AgentConfig> {
  const configPath = join(agentDir(name), "config.json");
  let config: AgentConfig;

  try {
    const raw = await readFile(configPath, "utf-8");
    config = JSON.parse(raw);
  } catch {
    throw new Error(
      `No config found for agent "${name}" at ${configPath}\n\n` +
      `Create it:\n` +
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

  const errors = validateAgentConfig(config);
  if (errors.length > 0) {
    throw new Error(
      `Invalid config for agent "${name}":\n` +
      errors.map((e) => `  - ${e}`).join("\n")
    );
  }

  return config;
}

export async function loadSoul(name: string = getAgentName()): Promise<string> {
  const soulPath = join(agentDir(name), "SOUL.md");
  try {
    return await readFile(soulPath, "utf-8");
  } catch {
    return "";
  }
}
