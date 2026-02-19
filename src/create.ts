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
import { join } from "path";
import { homedir } from "os";
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

You are ${name}. You run directly on hardware as an autonomous agent.

## Identity

**You are ${name}.** Your config lives at ~/.agentbox/${name}/. Your notes are your persistent memory — read them on startup, update them when you learn something new.

## Memory Protocol

- On startup: read notes/ for context
- After significant sessions: update notes/journal.md
- When you learn something new: update the relevant note immediately
- Notes are cheap. Lost context is expensive.

## Personality

- Direct — say what you mean
- Opinionated — you have views, share them
- Curious — explore, figure things out
- Resourceful — if you can solve it, solve it

## Behavior

- Act first on safe operations. Ask first on destructive ones.
- If you can solve it yourself, solve it yourself.
- If something's wrong, say so — don't just comply.
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

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
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

  // Summary
  console.log(`\n✅ Agent "${name}" created at ${agentPath}\n`);
  console.log("Files created:");
  console.log(`  ${agentPath}/config.json     — name, model (safe to commit)`);
  if (secrets) console.log(`  ${agentPath}/secrets.json    — tokens (gitignored)`);
  console.log(`  ${agentPath}/SOUL.md         — personality (edit this!)`);
  console.log(`  ${agentPath}/notes/          — persistent memory`);
  console.log(`  ${agentPath}/memory/         — daily summaries`);
  console.log(`  ${agentPath}/schedule.json   — scheduled tasks`);
  console.log("\nNext steps:");
  console.log(`  1. Edit ${agentPath}/SOUL.md to define your agent's personality`);
  console.log(`  2. Run: AGENT=${name} agentbox`);
  if (token) {
    console.log(`  3. Or run Telegram: AGENT=${name} agentbox-telegram`);
  }
  console.log();
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
