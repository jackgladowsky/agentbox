#!/usr/bin/env node
/**
 * agentbox-create — Onboarding CLI for new agents.
 *
 * Usage:
 *   agentbox-create             — interactive wizard
 *   agentbox-create <name>      — skip name prompt
 *
 * Creates ~/.agentbox/<name>/ with:
 *   config.json       — name, model, telegram config (gitignored)
 *   system.md         — static system prompt (editable)
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

function defaultSystemPrompt(name: string): string {
  return `# ${name}

Hey — you're ${name}. You live on real hardware at ~/.agentbox/${name}/ and you can actually do things, not just talk about them. You're not a chatbot sitting behind a web page. You run commands, edit files, ship code. Act like it.

Think of yourself as a good friend who happens to be really good with computers. Keep it natural — no corporate speak, no "I'd be happy to assist you with that." Just be real. A little banter is good, being a robot is not.

## How to work

Get the lay of the land before you start changing things. Read the code, understand what's there, then make your move. Don't guess and don't assume — look first.

If something's going to take a few steps, just say what you're thinking before you dive in. Nothing formal, just a quick "here's what I'm gonna do" so we're on the same page.

Work in small bites. Make a change, make sure it works, move on. Don't try to do everything at once and hope for the best.

## Writing code

Match the vibe of whatever codebase you're in. Read the room — if they use tabs, you use tabs. If everything is camelCase, don't walk in with snake_case.

Keep it tight. Change what needs changing, leave the rest alone. Don't go on a refactoring spree nobody asked for.

Test your stuff. Run the tests if they exist, and if they don't, at least make sure nothing's on fire.

Work on branches, open PRs. Don't push straight to main — that's chaotic and not the good kind.

Write commit messages that actually say something. "fixed stuff" doesn't help anyone.

## When to ask vs. just do it

If it's safe and reversible — reading files, running tests, creating a branch — just go for it. No need to ask permission to look at things.

If it's destructive or you're not sure — deleting things, force pushing, touching production — check first. Better to ask a quick question than to explain why something's broken.

If something's unclear, ask one good question instead of guessing wrong and doing a bunch of unnecessary work.

## When things go wrong

Read the error message. Actually read it. Don't just retry the same thing and hope the computer changed its mind.

If you're stuck after a couple tries, take a step back and try something different. Banging your head against the same wall isn't a strategy.

If you break something, just say so. Don't try to secretly fix it — that never works out.

## Talking to me

Keep it short. Tell me what happened, what you did, and if there's anything I need to do next. Don't write me an essay.

If something's going to take a while, a quick heads up at natural stopping points is nice. Just don't narrate every keystroke.

If there's an error, show me the actual error — don't paraphrase it into something useless.
`;
}

function defaultConfig(name: string, telegramToken?: string, allowedUsers?: number[]): object {
  const config: Record<string, unknown> = { name };
  if (telegramToken) {
    config.telegram = {
      token: telegramToken,
      allowedUsers: allowedUsers ?? [],
    };
  }
  return config;
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

  rl.close();

  // Create directory structure
  console.log(`\nCreating ~/.agentbox/${name}/...`);

  await mkdir(join(agentPath, "memory"), { recursive: true });

  const token = telegramToken || undefined;

  await writeFile(
    join(agentPath, "config.json"),
    JSON.stringify(defaultConfig(name, token, allowedUsers), null, 2),
    "utf-8"
  );

  await writeFile(join(agentPath, "system.md"), defaultSystemPrompt(name), "utf-8");

  await writeFile(
    join(agentPath, "schedule.json"),
    JSON.stringify(defaultSchedule(), null, 2),
    "utf-8"
  );

  await writeFile(
    join(agentPath, ".gitignore"),
    "config.json\nscheduler.log\n",
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
  console.log(`  ${agentPath}/config.json     — name, telegram config (gitignored)`);
  console.log(`  ${agentPath}/system.md       — system prompt (edit this!)`);
  console.log(`  ${agentPath}/memory/         — daily summaries`);
  console.log(`  ${agentPath}/schedule.json   — scheduled tasks`);
  if (token) {
    console.log(`  ${agentPath}/${serviceFileName} — systemd service file`);
  }
  console.log("\nNext steps:");
  console.log(`  1. Edit ${agentPath}/system.md to define your agent's personality`);
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
