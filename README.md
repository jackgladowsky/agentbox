# AgentBox

An autonomous AI agent runtime for dedicated hardware. Not a chatbot. Not a cloud service. An agent that runs on your machine, owns its environment, and actually does things.

## What It Is

AgentBox gives Claude a persistent home on your hardware:

- **Telegram interface** — talk to your agent from anywhere, with live streaming responses
- **Full shell access** — the agent can run commands, read/write files, install packages, manage processes
- **Persistent memory** — notes survive across sessions; the agent builds context about your system over time
- **Scheduled tasks** — cron-driven autonomous tasks with Telegram notifications
- **Skills system** — modular markdown docs that teach the agent about available CLI tools
- **Multi-agent support** — run multiple named agents on the same machine, each with their own identity and config
- **Claude Code OAuth** — uses your existing Claude Pro/Max subscription, no separate API billing
- **Context compaction** — long sessions auto-summarized via Gemini (1M context) so you never hit limits

## Prerequisites

- Node.js 18+
- A Claude subscription (Pro or Max) with the `claude` CLI installed and authenticated
- A Telegram bot token (from [@BotFather](https://t.me/botfather))
- Your Telegram user ID (from [@userinfobot](https://t.me/userinfobot))

## Setup

```bash
git clone https://github.com/jackgladowsky/agentbox.git
cd agentbox
npm install
npm run build
```

### Create your agent

```bash
npm run create
# or: AGENT=myagent npm run create myagent
```

This walks you through naming your agent and setting up Telegram, then creates `~/.agentbox/<name>/` with everything you need:

```
~/.agentbox/myagent/
  config.json       ← name, model, allowed Telegram users
  secrets.json      ← Telegram token, OpenRouter key (gitignored)
  SOUL.md           ← personality / system prompt (edit this)
  notes/            ← persistent memory (auto-managed by agent)
  memory/           ← daily session summaries
  schedule.json     ← scheduled tasks for the cron daemon
```

### Authenticate Claude

If you haven't already:

```bash
npm install -g @anthropic-ai/claude-code
claude  # follow the OAuth flow
```

## Running

```bash
# Telegram bot
AGENT=myagent npm run start:telegram

# Or via systemd (recommended)
cp systemd/agentbox.service ~/.config/systemd/user/myagent.service
# Edit WorkingDirectory, ExecStart path, and AGENT= in the file
systemctl --user enable --now myagent
```

## Multiple Agents

Each agent is fully isolated — separate identity, config, tokens, and memory:

```
~/.agentbox/
  myagent/
    config.json
    secrets.json
    SOUL.md
    notes/
  otheragent/
    config.json
    secrets.json
    SOUL.md
    notes/
```

Run simultaneously with different `AGENT=` env vars and different bot tokens.

## Configuration

**`~/.agentbox/<name>/config.json`** (safe to commit):
```json
{
  "name": "MyAgent",
  "model": "claude-sonnet-4-6",
  "telegram": {
    "allowedUsers": [123456789]
  }
}
```

**`~/.agentbox/<name>/secrets.json`** (never commit):
```json
{
  "telegramToken": "YOUR_BOT_TOKEN",
  "telegramAllowedUsers": [123456789],
  "openrouterKey": "sk-or-..."
}
```

The `openrouterKey` is optional but recommended — it enables Gemini-powered context compaction (1M context window) instead of the fallback trim strategy.

| Config field | Required | Description |
|---|---|---|
| `name` | yes | Display name |
| `model` | no | Anthropic model ID (default: `claude-sonnet-4-6`) |
| `telegram.allowedUsers` | yes | Telegram user ID whitelist |
| `telegramToken` (secrets) | yes | Bot token from @BotFather |
| `openrouterKey` (secrets) | no | Enables Gemini compaction |

## Telegram Commands

| Command | Description |
|---|---|
| `/help` | Show available commands |
| `/clear` `/reset` `/new` | Clear conversation history |
| `/status` | Agent name, model, message count |
| `/model <id>` | Switch model (e.g. `/model claude-opus-4-6`) |
| `/thinking` | Toggle extended thinking |
| `/update` | Pull latest code and restart |
| `/build` | Rebuild dist/ without restarting |

Send text, images, files, or voice messages — all supported.

## Scheduled Tasks

The scheduler daemon runs cron jobs with isolated agent instances. Configure in `~/.agentbox/<name>/schedule.json`:

```json
{
  "tasks": [
    {
      "id": "morning-check",
      "name": "Morning Check",
      "schedule": "0 9 * * *",
      "prompt": "Check system health and summarize anything worth knowing.",
      "notify": "on_issue"
    }
  ]
}
```

```bash
AGENT=myagent npm run start:scheduler
```

Hot-reload schedule without restarting: `kill -HUP <scheduler-pid>`

## Skills

Skills are markdown docs that teach the agent about available CLI tools:

```bash
npm run skill -- list
npm run skill -- install github
npm run skill -- remove github
```

Available skills are in `skills/` — each has a `SKILL.md` describing commands and usage.

## Architecture

```
src/
  core/             Agent brain and shared modules
    agent.ts        Agent factory, tools, context compaction
    agentbox.ts     Singleton — all connections talk through this
    auth.ts         Claude Code OAuth credential loading
    checkpoint.ts   Persist/restore context across restarts
    config.ts       Config + secrets loader
    memory.ts       Idle-triggered session write-back
    workspace.ts    System prompt builder

  connections/      Interface adapters
    telegram.ts     Telegram (grammY) — streaming, commands, file uploads
    tui.tsx         Terminal UI (Ink) — interactive local interface

  daemon/
    scheduler.ts    Cron daemon with isolated per-task agents

  cli/
    create.ts       agentbox-create onboarding wizard
    skill.ts        agentbox-skill manager

  entrypoints/
    telegram.ts     Boot script for Telegram
    tui.tsx         Boot script for TUI
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for how to add connections, skills, scheduled tasks, and more.

## Philosophy

See [VISION.md](./VISION.md) for the full picture.

Short version: most AI agents are constrained by design. AgentBox starts from the opposite assumption — real autonomy, explicit security, technical users only.

## License

ISC
