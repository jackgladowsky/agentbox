/**
 * Authentication using pi-ai's OAuth utilities.
 * Supports Claude Code, GitHub Copilot, Gemini CLI, and more.
 */
import {
  getOAuthProvider,
  getOAuthApiKey,
  anthropicOAuthProvider,
  type OAuthCredentials,
  type OAuthLoginCallbacks,
} from "@mariozechner/pi-ai";
import { readFile, writeFile, mkdir } from "fs/promises";
import { homedir } from "os";
import { join, dirname } from "path";
import { createInterface } from "readline";

const CREDENTIALS_PATH = join(homedir(), ".agentbox", "credentials.json");

export interface StoredCredentials {
  anthropic?: OAuthCredentials;
  "github-copilot"?: OAuthCredentials;
  "google-gemini-cli"?: OAuthCredentials;
}

/**
 * Load stored credentials from disk
 */
export async function loadCredentials(): Promise<StoredCredentials> {
  try {
    const data = await readFile(CREDENTIALS_PATH, "utf-8");
    return JSON.parse(data);
  } catch {
    return {};
  }
}

/**
 * Save credentials to disk
 */
export async function saveCredentials(creds: StoredCredentials): Promise<void> {
  await mkdir(dirname(CREDENTIALS_PATH), { recursive: true });
  await writeFile(CREDENTIALS_PATH, JSON.stringify(creds, null, 2));
}

/**
 * Get API key for a provider, auto-refreshing if needed.
 * Returns the key and updates stored credentials if refreshed.
 */
export async function getApiKey(
  providerId: "anthropic" | "github-copilot" | "google-gemini-cli"
): Promise<string | null> {
  const creds = await loadCredentials();
  
  // Try pi-ai's OAuth first (handles refresh automatically)
  const result = await getOAuthApiKey(providerId, creds as Record<string, OAuthCredentials>);
  
  if (result) {
    // Save updated credentials (may have been refreshed)
    creds[providerId] = result.newCredentials;
    await saveCredentials(creds);
    return result.apiKey;
  }
  
  // Fallback: check Claude Code's native credential store (~/.claude/.credentials.json)
  if (providerId === "anthropic") {
    try {
      const claudeCredsPath = join(homedir(), ".claude", ".credentials.json");
      const data = await readFile(claudeCredsPath, "utf-8");
      const claudeCreds = JSON.parse(data);
      
      if (claudeCreds.claudeAiOauth?.accessToken) {
        // Convert to pi-ai format and store
        const oauth: OAuthCredentials = {
          access: claudeCreds.claudeAiOauth.accessToken,
          refresh: claudeCreds.claudeAiOauth.refreshToken,
          expires: claudeCreds.claudeAiOauth.expiresAt,
        };
        creds.anthropic = oauth;
        await saveCredentials(creds);
        return oauth.access;
      }
    } catch {
      // No Claude Code credentials found
    }
  }
  
  return null;
}

/**
 * Login to a provider (interactive)
 */
export async function login(
  providerId: "anthropic" | "github-copilot" | "google-gemini-cli"
): Promise<boolean> {
  const provider = getOAuthProvider(providerId);
  if (!provider) {
    console.error(`Provider ${providerId} not found`);
    return false;
  }
  
  const callbacks: OAuthLoginCallbacks = {
    onAuth: (info) => {
      console.log(`\nOpen this URL to authenticate:\n${info.url}`);
      if (info.instructions) {
        console.log(info.instructions);
      }
    },
    onPrompt: async (prompt) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      return new Promise((resolve) => {
        rl.question(`${prompt.message}: `, (answer) => {
          rl.close();
          resolve(answer);
        });
      });
    },
    onProgress: (message) => {
      console.log(message);
    },
  };
  
  try {
    const creds = await provider.login(callbacks);
    const stored = await loadCredentials();
    stored[providerId] = creds;
    await saveCredentials(stored);
    return true;
  } catch (err) {
    console.error(`Login failed:`, err);
    return false;
  }
}

/**
 * Check if we have valid credentials for a provider
 */
export async function hasCredentials(
  providerId: "anthropic" | "github-copilot" | "google-gemini-cli"
): Promise<boolean> {
  const key = await getApiKey(providerId);
  return key !== null;
}
