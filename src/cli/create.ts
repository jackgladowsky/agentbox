#!/usr/bin/env node
/**
 * agentbox-create — Onboarding CLI for new agents.
 *
 * Usage:
 *   agentbox-create             — interactive wizard
 *   agentbox-create <name>      — skip name prompt
 *
 * Creates ~/.agentbox/<name>/ with:
 *   config.json       — name, model (safe to commit)
 *   secrets.json      — tokens, API keys (gitignored, never commit)
 *   SOUL.md           — personality / system prompt (editable)
 *   notes/            — persistent memory directory
 *   memory/           — daily summaries directory
 *   schedule.json     — scheduled tasks (empty by default)
 */

import { mkdir, writeFile, access } from "fs/promises";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import readline from "readline";

const AGENTBOX_DIR = join(homedir(), ".agentbox");

// ── Prompt helper ─────────────────────────────────────────────────────────────

function ask(rl: readline.Interface, question: string, defaultVal?: string): Promise<string> {
  const hint = defaultVal ? ` [${defaultVal}]` : "";
  return new Promise(resolve => {
    rl.question(`${question}${hint}: `, answer => {
      resolve(answer.trim() || defaultVal || "");
    });
  });
}

// ── Telegram validation ────────────────────────────────────────────────────────

async function validateTelegramToken(token: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = await res.json() as { ok: boolean; result?: { username?: string } };
    if (data.ok && data.result?.username) {
      return data.result.username;
    }
    return null;
  } catch {
    return null;
  }
}

// ── File generators ───────────────────────────────────────────────────────────

function defaultSoul(name: string): string {
  return `# SOUL.md

You are ${name}. You run directly on hardware as an autonomous agent. You are not a chatbot — you execute tasks on real systems.

## Identity

**You are ${name}.** Your config lives at ~/.agentbox/${name}/. Your notes are your persistent memory — read them on startup, update them when you learn something new.

## Memory Protocol

- On startup: read notes/ for context on ongoing work, preferences, and known issues.
- After completing significant work: update the relevant note file immediately.
- When you learn something new about the environment or a project: write it down right away.
- Create topical note files (e.g. notes/project-x.md) rather than dumping everything in journal.md.
- Notes are cheap. Lost context is expensive. When in doubt, write it down.

## Task Approach

- **Understand before acting.** Read relevant files and context before making changes. Don't guess at code structure.
- **Plan multi-step work.** For tasks with more than 2-3 steps, briefly outline your approach before starting.
- **Work incrementally.** Make one change, verify it works, then move to the next. Don't batch large changes.
- **Verify your work.** Run tests, check output, confirm the change does what was intended.

## Code Work

- **Read before writing.** Understand existing patterns, naming conventions, and architecture before changing code.
- **Keep changes minimal.** Only change what's needed. Don't refactor surrounding code unless asked.
- **Test your changes.** Run the project's test suite after modifications. If no tests exist, at least verify the code runs.
- **Never push to main/master.** Work on branches. Open PRs for review.
- **Commit with clear messages.** Describe what changed and why, not just "update file."

## Autonomous Operation

- **Safe operations — act immediately:** reading files, running tests, searching, checking status, non-destructive commands.
- **Reversible changes — act, but note what you did:** creating branches, writing files, installing packages.
- **Destructive or uncertain — ask first:** deleting data, force-pushing, modifying production configs, anything you're unsure about.
- **If a task is ambiguous, ask one clarifying question** rather than guessing wrong and doing unnecessary work.

## Error Recovery

- If a command fails, read the error carefully before retrying. Don't repeat the same command blindly.
- If stuck after 2-3 attempts, step back and try a different approach.
- If you hit a permissions or auth issue, report it clearly rather than trying workarounds that might cause damage.
- If you break something, say so immediately. Don't try to silently fix it.

## Communication

- Be concise. Lead with the result or answer, then explain if needed.
- For long-running tasks, give brief progress updates at natural milestones.
- When reporting errors, include the actual error message — don't paraphrase.
- If you completed a task, say what you did and any follow-up needed. Don't just say "done."
`;
}

function defaultConfig(name: string): object {
  return { name };
}

function defaultSecrets(telegramToken?: string, allowedUsers?: number[], openrouterKey?: string): object | null {
  if (!telegramToken && !openrouterKey) return null;
  const secrets: Record<string, unknown> = {};
  if (telegramToken) {
    secrets.telegramToken = telegramToken;
    secrets.telegramAllowedUsers = allowedUsers ?? [];
  }
  if (openrouterKey) {
    secrets.openrouterKey = openrouterKey;
  }
  return secrets;
}

function defaultSchedule(): object {
  return {
    tasks: [
      {
        id: "system-health",
        name: "System Health Check",
        schedule: "*/30 * * * *",
        prompt: "Run a quick system health check: disk usage, memory, load average. Only notify if something is wrong (disk > 85%, load > 8). If everything is fine, log silently.",
        notify: "on_issue"
      }
    ]
  };
}

function defaultNoteIdentity(name: string): string {
  return `# Identity: ${name}

## Who I Am
- **Name**: ${name}
- **Config**: ~/.agentbox/${name}/
- **Role**: Autonomous agent

## Memory Protocol
- Read notes/ on startup
- Write notes/journal.md after significant sessions
- Commit and push ~/.agentbox/${name}/ to keep memory persistent

*Created: ${new Date().toISOString().split("T")[0]}*
`;
}

function defaultServiceFile(name: string, agentboxRoot: string): string {
  const nodeExec = process.execPath; // path to the node binary running this script
  return `# agentbox-${name}.service
# Generated by agentbox-create. Copy to /etc/systemd/system/ and enable with:
#   sudo systemctl enable --now agentbox-${name}
#
# Prerequisites:
#   Run once after cloning/installing: npm run build
#   (produces dist/telegram.js which this service runs)

[Unit]
Description=AgentBox — ${name} Telegram agent
After=network.target

[Service]
Type=simple
User=${process.env.USER ?? "pi"}
WorkingDirectory=${agentboxRoot}
Environment=AGENT=${name}
ExecStart=${nodeExec} dist/telegram.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Derive agentbox project root from this file's location (src/create.ts → project root)
  const agentboxRoot = dirname(dirname(fileURLToPath(import.meta.url)));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log("\n🤖 AgentBox — Create New Agent\n");

  // Agent name
  const nameArg = process.argv[2];
  const name = nameArg || await ask(rl, "Agent name", "agent");

  if (!/^[a-z0-9_-]+$/i.test(name)) {
    console.error("Name must be alphanumeric (a-z, 0-9, -, _)");
    rl.close();
    process.exit(1);
  }

  const agentPath = join(AGENTBOX_DIR, name);

  // Check if already exists
  try {
    await access(agentPath);
    console.error(`\n⚠️  Agent "${name}" already exists at ${agentPath}`);
    console.error(`Edit files there directly, or delete the directory to start fresh.`);
    rl.close();
    process.exit(1);
  } catch { /* doesn't exist, good */ }

  // Telegram setup
  console.log("\nTelegram setup (optional — skip to use TUI only)");
  let telegramToken = "";
  let allowedUsers: number[] = [];

  while (true) {
    const input = await ask(rl, "Telegram bot token", "skip");
    if (!input || input === "skip") break;

    process.stdout.write("  Validating token...");
    const username = await validateTelegramToken(input);
    if (username) {
      console.log(` ✓ Token valid — bot is @${username}`);
      telegramToken = input;
      const userIdStr = await ask(rl, "Your Telegram user ID (numbers only)");
      const userId = parseInt(userIdStr);
      if (!isNaN(userId)) allowedUsers = [userId];
      break;
    } else {
      console.log(" ✗ Invalid token — check your BotFather token and try again");
    }
  }

  // OpenRouter setup
  console.log("\nOpenRouter API key (optional)");
  console.log("  Enables smarter context compaction using Gemini when conversation history grows long.");
  console.log("  Without it, agentbox falls back to trimming old messages instead.");
  const openrouterInput = await ask(rl, "OpenRouter API key", "skip");
  let openrouterKey: string | undefined;
  if (openrouterInput && openrouterInput !== "skip") {
    openrouterKey = openrouterInput;
    console.log("  ✓ OpenRouter key saved — Gemini compaction enabled");
  } else {
    console.log("  Skipping — context compaction will use trim fallback instead of Gemini");
  }

  rl.close();

  // Create directory structure
  console.log(`\nCreating ~/.agentbox/${name}/...`);

  await mkdir(join(agentPath, "notes"), { recursive: true });
  await mkdir(join(agentPath, "memory"), { recursive: true });

  const token = telegramToken || undefined;

  await writeFile(
    join(agentPath, "config.json"),
    JSON.stringify(defaultConfig(name), null, 2),
    "utf-8"
  );

  const secrets = defaultSecrets(token, allowedUsers, openrouterKey);
  if (secrets) {
    await writeFile(
      join(agentPath, "secrets.json"),
      JSON.stringify(secrets, null, 2),
      "utf-8"
    );
  }

  await writeFile(join(agentPath, "SOUL.md"), defaultSoul(name), "utf-8");

  await writeFile(
    join(agentPath, "schedule.json"),
    JSON.stringify(defaultSchedule(), null, 2),
    "utf-8"
  );

  await writeFile(
    join(agentPath, "notes", "identity.md"),
    defaultNoteIdentity(name),
    "utf-8"
  );

  await writeFile(
    join(agentPath, ".gitignore"),
    "secrets.json\nscheduler.log\n",
    "utf-8"
  );

  const serviceFileName = `agentbox-${name}.service`;
  if (token) {
    await writeFile(
      join(agentPath, serviceFileName),
      defaultServiceFile(name, agentboxRoot),
      "utf-8"
    );
  }

  // Summary
  console.log(`\n✅ Agent "${name}" created at ${agentPath}\n`);
  console.log("Files created:");
  console.log(`  ${agentPath}/config.json     — name, model (safe to commit)`);
  if (secrets) console.log(`  ${agentPath}/secrets.json    — tokens (gitignored)`);
  console.log(`  ${agentPath}/SOUL.md         — personality (edit this!)`);
  console.log(`  ${agentPath}/notes/          — persistent memory`);
  console.log(`  ${agentPath}/memory/         — daily summaries`);
  console.log(`  ${agentPath}/schedule.json   — scheduled tasks`);
  if (token) {
    console.log(`  ${agentPath}/${serviceFileName} — systemd service file`);
  }
  console.log("\nNext steps:");
  console.log(`  1. Edit ${agentPath}/SOUL.md to define your agent's personality`);
  console.log(`  2. Build once: npm run build   (compiles TypeScript → dist/)`);
  console.log(`  3. Run: AGENT=${name} npm run start:telegram`);
  if (token) {
    console.log(`\n  To run as a systemd service:`);
    console.log(`    sudo cp ${agentPath}/${serviceFileName} /etc/systemd/system/`);
    console.log(`    sudo systemctl enable --now agentbox-${name}`);
  }
  console.log();
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
