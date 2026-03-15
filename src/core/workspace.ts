import { readFile, readdir } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { getAgentName, agentDir } from "./config.js";

export interface WorkspaceContext {
  systemPrompt: string;
  agentName: string;
}

/** Root of the agentbox project (src/core/workspace.ts → ../../) */
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKILLS_DIR = join(PROJECT_ROOT, "skills");

/**
 * Extract the first heading and the first non-empty line after it from a skill.md.
 * Returns [name, description] or null if the file can't be parsed.
 */
function parseSkillHeader(content: string): [string, string] | null {
  const lines = content.split("\n");
  let name: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!name) {
      const match = trimmed.match(/^#\s+(.+)$/);
      if (match) name = match[1];
    } else if (trimmed) {
      return [name, trimmed];
    }
  }

  return null;
}

/**
 * Scan skills/ directory and build a condensed index for the system prompt.
 * Returns empty string if no skills are found.
 */
async function buildSkillsIndex(): Promise<string> {
  let entries: string[];
  try {
    entries = await readdir(SKILLS_DIR, { withFileTypes: true })
      .then(dirents => dirents.filter(d => d.isDirectory()).map(d => d.name));
  } catch {
    return "";
  }

  if (entries.length === 0) return "";

  const skills: string[] = [];

  for (const name of entries.sort()) {
    try {
      const content = await readFile(join(SKILLS_DIR, name, "skill.md"), "utf-8");
      const parsed = parseSkillHeader(content);
      if (parsed) {
        skills.push(`- **${parsed[0]}** — ${parsed[1]}`);
      }
    } catch {
      // No skill.md or unreadable — skip
    }
  }

  if (skills.length === 0) return "";

  return [
    "",
    "## Available Skills",
    "",
    "You have the following skills available. Each one has a detailed `skill.md` in the `skills/` directory — read it before using a skill for the first time.",
    "",
    ...skills,
    "",
  ].join("\n");
}

export async function loadWorkspaceContext(): Promise<WorkspaceContext> {
  const agentName = getAgentName();
  const systemPath = join(agentDir(agentName), "system.md");
  const systemPrompt = await readFile(systemPath, "utf-8");
  const skillsIndex = await buildSkillsIndex();

  return {
    systemPrompt: systemPrompt + skillsIndex,
    agentName,
  };
}
