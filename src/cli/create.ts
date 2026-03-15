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
import { execSync } from "child_process";
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

function telegramService(name: string, agentboxRoot: string): string {
  const nodeExec = process.execPath;
  const nodeBinDir = dirname(nodeExec);
  return `[Unit]
Description=AgentBox ${name} — Telegram bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${agentboxRoot}
Environment=AGENT=${name}
Environment=PATH=${nodeBinDir}:/usr/local/bin:/usr/bin:/bin
ExecStart=${nodeExec} dist/entrypoints/telegram.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function schedulerService(name: string, agentboxRoot: string): string {
  const nodeExec = process.execPath;
  const nodeBinDir = dirname(nodeExec);
  return `[Unit]
Description=AgentBox ${name} — Scheduler daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${agentboxRoot}
Environment=AGENT=${name}
Environment=PATH=${nodeBinDir}:/usr/local/bin:/usr/bin:/bin
ExecStart=${nodeExec} dist/daemon/scheduler.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

// ── Deploy helpers ───────────────────────────────────────────────────────────

function runCmd(cmd: string, cwd?: string): void {
  try {
    execSync(cmd, { stdio: "inherit", cwd });
  } catch {
    console.error(`Command failed: ${cmd}`);
    process.exit(1);
  }
}

async function deployAgent(name: string, agentboxRoot: string): Promise<void> {
  const systemdDir = join(homedir(), ".config", "systemd", "user");
  const botUnit = `agentbox-${name}.service`;
  const schedUnit = `agentbox-${name}-scheduler.service`;

  // Build
  console.log("\n⚙️  Building...");
  runCmd("npm run build", agentboxRoot);

  // Install systemd services
  console.log("\n📦 Installing systemd services...");
  await mkdir(systemdDir, { recursive: true });
  await writeFile(join(systemdDir, botUnit), telegramService(name, agentboxRoot));
  await writeFile(join(systemdDir, schedUnit), schedulerService(name, agentboxRoot));

  // Reload + enable + start
  runCmd("systemctl --user daemon-reload");
  console.log("\n🚀 Starting services...");
  runCmd(`systemctl --user enable --now ${botUnit} ${schedUnit}`);

  console.log("\n✅ Agent is live!\n");
  console.log("Useful commands:");
  console.log(`  journalctl --user -u ${botUnit} -f           # bot logs`);
  console.log(`  journalctl --user -u ${schedUnit} -f      # scheduler logs`);
  console.log(`  systemctl --user status ${botUnit}            # bot status`);
  console.log(`  systemctl --user restart ${botUnit}           # restart bot`);
  console.log(`  AGENT=${name} npm run deploy                  # rebuild + restart`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Derive agentbox project root from this file's location (src/create.ts → project root)
  // src/cli/create.ts → src/cli → src → project root
  const agentboxRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

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

  console.log(`\n✅ Agent "${name}" created at ${agentPath}`);
  console.log(`  config.json     — name, telegram config`);
  console.log(`  system.md       — system prompt (edit this!)`);
  console.log(`  schedule.json   — scheduled tasks`);

  // Deploy
  if (token) {
    await deployAgent(name, agentboxRoot);
  } else {
    console.log("\nNo Telegram token — skipping deploy.");
    console.log(`To run manually: AGENT=${name} npm run dev`);
    console.log();
  }
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exit(1);
});
