import { readFile, access, readdir } from "fs/promises";
import { join } from "path";
import { hostname, platform, arch, userInfo } from "os";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { loadSoul, notesDir, getAgentName, loadAgentConfig } from "./config.js";

/** Maximum characters allowed for the notes section of the system prompt */
const NOTES_BUDGET = 6000;

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

  return `# AgentBox

You are **${agentName}**, an autonomous agent running on real hardware.

## Environment

- **Host:** ${host}
- **Platform:** ${plat} (${architecture})
- **User:** ${user}
- **Working Directory:** ${cwd}
- **Date/Time:** ${datetime}

## Tools

- **shell** — Execute any command
- **read_file** — Read any file
- **write_file** — Create or modify files
- **list_dir** — Explore the filesystem

## Identity & Behavior

Your personality, values, and operating principles are defined in SOUL.md. That file is your source of truth for who you are and how you operate.

`;
}

/**
 * Load all markdown notes from the agent's notes/ directory.
 */
async function loadNotes(name: string): Promise<{ filename: string; content: string }[]> {
  const dir = notesDir(name);
  try {
    const entries = await readdir(dir);
    const notes: { filename: string; content: string }[] = [];
    for (const entry of entries.filter(e => e.endsWith(".md")).sort()) {
      try {
        const content = await readFile(join(dir, entry), "utf-8");
        if (content.trim()) notes.push({ filename: entry, content: content.trim() });
      } catch { /* skip unreadable */ }
    }
    return notes;
  } catch {
    return []; // notes/ doesn't exist yet, that's fine
  }
}

/**
 * Condense the loaded notes to fit within the character budget.
 * If the raw notes fit, they are returned verbatim; otherwise we ask
 * Haiku to produce a short paragraph summary referencing file paths.
 * Falls back to naive truncation if the API call fails.
 */
async function summarizeNotes(notes: { filename: string; content: string }[]): Promise<string> {
  if (notes.length === 0) return "";

  const rawParts = notes.map(({ filename, content }) => `## ${filename}\n${content}`);
  const rawText = rawParts.join("\n\n");

  // If everything fits, return as-is
  if (rawText.length <= NOTES_BUDGET) {
    return `# Agent Notes\n\n${rawText}\n\n`;
  }

  // Over budget — ask Claude to summarize via the agent SDK (handles auth natively)
  try {
    const prompt =
      `Summarize the following agent notes into a short paragraph (under ${NOTES_BUDGET} characters). ` +
      `Reference the source filenames (e.g. "see goals.md") when relevant so the agent knows where to look for details. ` +
      `Output ONLY the summary, no preamble.\n\n${rawText}`;

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

    if (summary.trim()) {
      return `# Agent Notes (summarized)\n\n${summary.trim()}\n\n`;
    }
  } catch (err) {
    console.warn("[workspace] Notes summarization failed, falling back to truncation:", err);
  }

  // Fallback — naive proportional truncation
  let result = "# Agent Notes (condensed)\n\n";
  const perNoteBudget = Math.floor(NOTES_BUDGET / notes.length);

  for (const { filename, content } of notes) {
    const header = `## ${filename}\n`;
    const maxContent = Math.max(perNoteBudget - header.length - 50, 0);
    if (content.length <= maxContent) {
      result += `${header}${content}\n\n`;
    } else {
      result += `${header}${content.slice(0, maxContent)}\u2026\n_(truncated \u2014 ${content.length} chars total)_\n\n`;
    }
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

  // Load notes (budget-aware, LLM-summarized if over budget)
  const notes = await loadNotes(agentName);
  systemPrompt += await summarizeNotes(notes);

  return { systemPrompt, agentName };
}
