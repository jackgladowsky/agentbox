/**
 * Shared skill parsing and manifest generation.
 *
 * Used by both the `skill` CLI and the system prompt builder.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Skill {
  name: string;
  description: string;
  cliType: "prebuilt" | "custom";
  binary: string;
  installCmd: string | null;
  repo: string | null;
  authRequired: "yes" | "no" | "optional";
  envVars: string[];
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export function parseSkillMd(filePath: string): Skill {
  const raw = readFileSync(filePath, "utf8");
  const lines = raw.split("\n");

  const name = (lines.find(l => l.startsWith("# ")) ?? "").replace(/^# /, "").trim();
  const descIdx = lines.findIndex(l => l.startsWith("# "));
  const description = descIdx >= 0 ? (lines[descIdx + 2] ?? "").trim() : "";

  const get = (label: string): string | null => {
    const pattern = new RegExp(`^-\\s+\\*\\*${label}:\\*\\*\\s*\`?([^\`\\n]+)\`?`);
    for (const line of lines) {
      const m = line.match(pattern);
      if (m) return m[1].trim();
    }
    return null;
  };

  const rawType = get("Type") ?? "prebuilt";
  const cliType: "prebuilt" | "custom" = rawType === "custom" ? "custom" : "prebuilt";

  const binary = get("Binary") ?? name;
  const installCmd = get("Install");
  const repo = get("Repo");

  const rawAuth = (get("Required") ?? "no").toLowerCase();
  let authRequired: "yes" | "no" | "optional" = "no";
  if (rawAuth === "yes") authRequired = "yes";
  else if (rawAuth.startsWith("only") || rawAuth.startsWith("optional")) authRequired = "optional";

  const envVars: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*-\s+\*\*Env:\*\*\s+`?([^`\n]+)`?/);
    if (m) {
      m[1].split(",").forEach(v => {
        const trimmed = v.trim().replace(/`/g, "");
        if (trimmed) envVars.push(trimmed);
      });
    }
  }

  return { name, description, cliType, binary, installCmd, repo, authRequired, envVars };
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export function loadAllSkills(skillsDir: string): Skill[] {
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir)
    .filter(d => {
      const p = join(skillsDir, d);
      return statSync(p).isDirectory() && existsSync(join(p, "skill.md"));
    })
    .map(d => parseSkillMd(join(skillsDir, d, "skill.md")))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Manifest builder (for system prompt injection)
// ---------------------------------------------------------------------------

const DEFAULT_SKILLS_BUDGET = 2000;

/**
 * Build a condensed skills manifest for the system prompt.
 * Each skill gets a one-liner with name, description, and binary.
 * If the full manifest exceeds the budget, entries are trimmed to name + description only.
 */
export function buildSkillsManifest(skillsDir: string, budget = DEFAULT_SKILLS_BUDGET): string {
  const skills = loadAllSkills(skillsDir);
  if (skills.length === 0) return "";

  // Full format: name, description, binary
  const fullEntries = skills.map(s =>
    `- **${s.name}** — ${s.description} Binary: \`${s.binary}\`.`
  );
  const fullText = `# Available Skills\n\n${fullEntries.join("\n")}\n\nFor full documentation on any skill, read \`skills/<name>/skill.md\`.\n\n`;

  if (fullText.length <= budget) return fullText;

  // Compact format: name + description only
  const compactEntries = skills.map(s => `- **${s.name}** — ${s.description}`);
  const compactText = `# Available Skills\n\n${compactEntries.join("\n")}\n\nFor full docs: \`skills/<name>/skill.md\`.\n\n`;

  return compactText;
}
