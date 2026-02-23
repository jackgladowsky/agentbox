/**
 * Agent configuration loader.
 *
 * Each agent lives in ~/.agentbox/<agent-name>/
 *   config.json   — name, model, non-sensitive settings (safe to commit)
 *   secrets.json  — tokens, API keys (gitignored, never commit)
 *   SOUL.md       — personality / system prompt
 *   notes/        — persistent memory (read by workspace.ts)
 *
 * Agent is selected via AGENT env var (default: "agent").
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
  /** Telegram connection config — token lives in secrets.json */
  telegram?: TelegramConfig;
  /** IANA timezone string for the agent (e.g. "America/New_York"). Defaults to system timezone. */
  timezone?: string;

  /** OpenRouter API key — loaded from secrets.json, used for compaction */
  openrouterKey?: string;
}

export interface AgentSecrets {
  /** Telegram bot token */
  telegramToken?: string;
  /** Telegram allowed user IDs (can also be in config.json if not sensitive) */
  telegramAllowedUsers?: number[];
  /** OpenRouter API key for cheap/large-context model calls (e.g. compaction) */
  openrouterKey?: string;
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
 * Load secrets.json for the given agent (returns empty object if missing).
 */
async function loadAgentSecrets(name: string): Promise<AgentSecrets> {
  const secretsPath = join(agentDir(name), "secrets.json");
  try {
    const raw = await readFile(secretsPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Validate an AgentConfig and return an array of error strings.
 * An empty array means the config is valid.
 */
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
 * Load config.json for the given agent, merged with secrets.json.
 * Tokens from secrets.json take precedence over anything in config.json.
 * Throws with a helpful message if config.json is missing.
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
      `Run: agentbox-create ${name}\n\n` +
      `Or create manually:\n` +
      `  mkdir -p ~/.agentbox/${name}\n` +
      `  echo '{"name":"${name}"}' > ~/.agentbox/${name}/config.json\n` +
      `  echo '{"telegramToken":"YOUR_TOKEN","telegramAllowedUsers":[YOUR_ID]}' > ~/.agentbox/${name}/secrets.json`
    );
  }

  // Merge secrets — values from secrets.json override config.json
  const secrets = await loadAgentSecrets(name);

  if (secrets.telegramToken) {
    config.telegram = {
      token: secrets.telegramToken,
      allowedUsers: secrets.telegramAllowedUsers ?? config.telegram?.allowedUsers ?? [],
    };
  }

  if (secrets.openrouterKey) {
    config.openrouterKey = secrets.openrouterKey;
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
