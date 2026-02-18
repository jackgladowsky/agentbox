import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken: string;
    refreshToken: string;
    expiresAt: string;
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
 * Read Claude Code OAuth credentials from ~/.claude/.credentials.json
 */
export async function getClaudeCredentials(): Promise<AuthToken | null> {
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
  } catch (err) {
    return null;
  }
}

/**
 * Check if credentials are expired or will expire soon
 */
export function isExpired(auth: AuthToken, bufferMs = 60000): boolean {
  return auth.expiresAt.getTime() - bufferMs < Date.now();
}
