/**
 * Authentication — Claude Agent SDK uses Claude Code's existing credentials.
 * No OAuth dance needed. Just check if credentials exist.
 */
import { readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

const CLAUDE_CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json");

/**
 * Check if Claude Code has valid credentials on this machine.
 * The Agent SDK delegates auth to Claude Code, so we just verify the file exists.
 */
export async function hasCredentials(): Promise<boolean> {
  try {
    const data = await readFile(CLAUDE_CREDENTIALS_PATH, "utf-8");
    const creds = JSON.parse(data);
    return Boolean(creds?.claudeAiOauth?.accessToken);
  } catch {
    return false;
  }
}
