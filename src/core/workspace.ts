import { readFile, readdir, stat } from "fs/promises";
import { join, dirname } from "path";
import { hostname, platform, arch, userInfo, homedir } from "os";
import { fileURLToPath } from "url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { loadSoul, notesDir, getAgentName, loadAgentConfig } from "./config.js";
import { buildSkillsManifest } from "./skills.js";

/** Maximum characters allowed for the notes section of the system prompt */
const NOTES_BUDGET = 6000;

/** High-priority note filenames that should be preserved verbatim when possible */
const HIGH_PRIORITY_NOTES = ["identity.md", "goals.md", "projects.md"];

/** Low-priority note filenames that get dropped first when over budget */
const LOW_PRIORITY_NOTES = ["journal.md"];

export interface WorkspaceContext {
  systemPrompt: string;
  agentName: string;
}

/**
 * Get the current date/time formatted for the agent's timezone.
 * Falls back to the system timezone if none is configured.
 */
function getCurrentDatetime(timezone?: string): string {
  const tz = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = new Date();
  const formatted = now.toLocaleString("en-US", {
    timeZone: tz,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
  return formatted;
}

/**
 * Build the core preamble — establishes what AgentBox is and the agent's environment.
 */
function buildPreamble(agentName: string, timezone?: string): string {
  const user = userInfo().username;
  const host = hostname();
  const plat = platform();
  const architecture = arch();
  const cwd = process.cwd();
  const datetime = getCurrentDatetime(timezone);
  const shell = process.env.SHELL ?? "unknown";
  const home = homedir();
  const nodeVersion = process.version;

  return `# AgentBox

You are **${agentName}**, an autonomous agent running on real hardware.

## Environment

- **Host:** ${host}
- **Platform:** ${plat} (${architecture})
- **User:** ${user}
- **Home:** ${home}
- **Shell:** ${shell}
- **Node:** ${nodeVersion}
- **Working Directory:** ${cwd}
- **Date/Time:** ${datetime}

## Identity & Behavior

Your personality, values, and operating principles are defined in SOUL.md. That file is your source of truth for who you are and how you operate.

## Tool Usage

- Prefer reading files directly over echoing them via bash.
- Chain related bash commands with \`&&\` when they depend on each other.
- For file searches, use specific paths rather than searching the entire filesystem.
- When running long commands, check output before proceeding to the next step.

`;
}

interface NoteEntry {
  filename: string;
  content: string;
  mtime: number;
}

/**
 * Load all markdown notes from the agent's notes/ directory.
 */
async function loadNotes(name: string): Promise<NoteEntry[]> {
  const dir = notesDir(name);
  try {
    const entries = await readdir(dir);
    const notes: NoteEntry[] = [];
    for (const entry of entries.filter(e => e.endsWith(".md")).sort()) {
      try {
        const filePath = join(dir, entry);
        const [content, fileStat] = await Promise.all([
          readFile(filePath, "utf-8"),
          stat(filePath),
        ]);
        if (content.trim()) {
          notes.push({ filename: entry, content: content.trim(), mtime: fileStat.mtimeMs });
        }
      } catch { /* skip unreadable */ }
    }
    return notes;
  } catch {
    return []; // notes/ doesn't exist yet, that's fine
  }
}

/**
 * Assign a priority score to a note. Higher = more important.
 */
function priorityScore(filename: string, mtime: number): number {
  let score = 0;

  // High-priority filenames get a big boost
  if (HIGH_PRIORITY_NOTES.includes(filename)) score += 1000;

  // Low-priority filenames get penalized
  if (LOW_PRIORITY_NOTES.includes(filename)) score -= 500;

  // Recency boost: notes modified in the last 24h get a boost, scaled by how recent
  const ageMs = Date.now() - mtime;
  const ageHours = ageMs / (1000 * 60 * 60);
  if (ageHours < 24) score += Math.floor(100 * (1 - ageHours / 24));

  return score;
}

/**
 * Summarize a single note file into 2-3 bullet points using Haiku.
 */
async function summarizeSingleNote(filename: string, content: string): Promise<string> {
  try {
    const prompt =
      `Summarize this note file ("${filename}") into 2-3 concise bullet points. ` +
      `Preserve key facts, decisions, and any actionable items. ` +
      `Output ONLY the bullet points, no preamble.\n\n${content}`;

    let summary = "";
    for await (const msg of query({
      prompt,
      options: {
        model: "claude-haiku-4-5",
        maxTurns: 1,
        allowedTools: [],
      },
    })) {
      if ("result" in msg) {
        summary = msg.result;
      }
    }
    return summary.trim();
  } catch {
    // If summarization fails, truncate instead
    const maxLen = 300;
    if (content.length <= maxLen) return content;
    return content.slice(0, maxLen) + "\u2026 _(truncated)_";
  }
}

/**
 * Condense the loaded notes to fit within the character budget.
 *
 * Strategy:
 * 1. Sort by priority (important filenames first, then by recency)
 * 2. Include high-priority notes verbatim as long as they fit
 * 3. Summarize remaining notes per-file using Haiku (preserves structure)
 * 4. Drop lowest-priority notes if still over budget, listing them in a footer
 * 5. Falls back to naive truncation if all API calls fail
 */
async function summarizeNotes(notes: NoteEntry[]): Promise<string> {
  if (notes.length === 0) return "";

  // Sort by priority descending
  const sorted = [...notes].sort(
    (a, b) => priorityScore(b.filename, b.mtime) - priorityScore(a.filename, a.mtime)
  );

  const rawParts = sorted.map(({ filename, content }) => `## ${filename}\n${content}`);
  const rawText = rawParts.join("\n\n");

  // If everything fits, return as-is
  if (rawText.length <= NOTES_BUDGET) {
    return `# Agent Notes\n\n${rawText}\n\n`;
  }

  // Over budget — use per-file summarization with priority-based inclusion
  let result = "# Agent Notes\n\n";
  let remaining = NOTES_BUDGET - result.length - 100; // reserve space for footer
  const omitted: string[] = [];

  // First pass: include high-priority notes verbatim if they fit
  const toSummarize: NoteEntry[] = [];
  for (const note of sorted) {
    const block = `## ${note.filename}\n${note.content}\n\n`;
    if (HIGH_PRIORITY_NOTES.includes(note.filename) && block.length <= remaining) {
      result += block;
      remaining -= block.length;
    } else {
      toSummarize.push(note);
    }
  }

  // Second pass: summarize remaining notes concurrently
  if (toSummarize.length > 0) {
    const summaries = await Promise.all(
      toSummarize.map(async note => ({
        filename: note.filename,
        summary: await summarizeSingleNote(note.filename, note.content),
      }))
    );

    for (const { filename, summary } of summaries) {
      const block = `## ${filename} _(summarized)_\n${summary}\n\n`;
      if (block.length <= remaining) {
        result += block;
        remaining -= block.length;
      } else {
        omitted.push(filename);
      }
    }
  }

  // Footer listing omitted files
  if (omitted.length > 0) {
    result += `_(Additional notes not shown: ${omitted.join(", ")} — read them directly for full context)_\n\n`;
  }

  return result;
}

/**
 * Build the full system prompt for the agent.
 */
export async function loadWorkspaceContext(): Promise<WorkspaceContext> {
  const agentName = getAgentName();
  const config = await loadAgentConfig(agentName);

  let systemPrompt = buildPreamble(agentName, config.timezone);

  // Load SOUL.md from agent dir
  const soul = await loadSoul(agentName);
  if (soul.trim()) {
    systemPrompt += `# Identity & Configuration\n\n## SOUL.md\n${soul.trim()}\n\n`;
  }

  // Load skills manifest
  const skillsDir = join(dirname(fileURLToPath(import.meta.url)), "../../skills");
  const skillsManifest = buildSkillsManifest(skillsDir);
  if (skillsManifest) {
    systemPrompt += skillsManifest;
  }

  // Load notes (budget-aware, LLM-summarized if over budget)
  const notes = await loadNotes(agentName);
  systemPrompt += await summarizeNotes(notes);

  return { systemPrompt, agentName };
}
