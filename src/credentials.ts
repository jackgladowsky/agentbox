import { execSync } from "child_process";
import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    subscriptionType: string;
    rateLimitTier: string;
    scopes: string[];
  };
}

export interface AuthToken {
  token: string;
  expiresAt: Date;
  subscriptionType: string;
}

/**
 * Read Claude Code OAuth credentials.
 * On macOS: checks Keychain first (where Claude Code actually stores them)
 * Fallback: ~/.claude/.credentials.json (Linux)
 */
export async function getClaudeCredentials(): Promise<AuthToken | null> {
  // macOS: check Keychain first
  if (process.platform === "darwin") {
    try {
      const result = execSync(
        'security find-generic-password -s "Claude Code-credentials" -w',
        { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }
      );
      const creds: ClaudeCredentials = JSON.parse(result.trim());

      if (creds.claudeAiOauth?.accessToken) {
        return {
          token: creds.claudeAiOauth.accessToken,
          expiresAt: new Date(creds.claudeAiOauth.expiresAt),
          subscriptionType: creds.claudeAiOauth.subscriptionType,
        };
      }
    } catch {
      // Keychain not available or no credentials, fall through to file check
    }
  }

  // Fallback: file-based credentials (Linux or if Keychain fails)
  const credPath = join(homedir(), ".claude", ".credentials.json");

  try {
    const data = await readFile(credPath, "utf-8");
    const creds: ClaudeCredentials = JSON.parse(data);

    if (!creds.claudeAiOauth?.accessToken) {
      return null;
    }

    return {
      token: creds.claudeAiOauth.accessToken,
      expiresAt: new Date(creds.claudeAiOauth.expiresAt),
      subscriptionType: creds.claudeAiOauth.subscriptionType,
    };
  } catch {
    return null;
  }
}

/**
 * Check if credentials are expired or will expire soon
 */
export function isExpired(auth: AuthToken, bufferMs = 60000): boolean {
  return auth.expiresAt.getTime() - bufferMs < Date.now();
}
