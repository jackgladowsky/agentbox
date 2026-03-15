# AgentBox

An autonomous AI agent runtime for dedicated hardware. Not a chatbot. Not a cloud service. An agent that runs on your machine, owns its environment, and actually does things.

## What It Is

AgentBox gives Claude a persistent home on your hardware:

- **Telegram interface** — talk to your agent from anywhere, with live streaming responses
- **Full shell access** — the agent can run commands, read/write files, install packages, manage processes
- **Persistent memory** — notes survive across sessions; the agent builds context about your system over time
- **Session resumption** — conversations persist across restarts via the Claude Agent SDK
- **Scheduled tasks** — cron-driven autonomous tasks with Telegram notifications
- **Skills system** — modular markdown docs that teach the agent about available CLI tools
- **Multi-agent support** — run multiple named agents on the same machine, each with their own identity and config
- **Claude Code OAuth** — uses your existing Claude Pro/Max subscription, no separate API billing
- **Smart note condensation** — over-budget notes auto-summarized via Haiku so context stays tight

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
# or: AGENT=myagent npm run create
```

This walks you through naming your agent and setting up Telegram, then creates `~/.agentbox/<name>/` with everything you need:

```
~/.agentbox/myagent/
  config.json       ← name, model, telegram token, allowed users (gitignore this)
  SOUL.md           ← personality / system prompt (edit this)
  notes/            ← persistent memory (auto-managed by agent)
  session_id        ← current SDK session ID (auto-managed)
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
# Development (tsx)
AGENT=myagent npm run dev

# Production (compiled)
npm run build
AGENT=myagent npm start

# Or via systemd (recommended for always-on)
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
    SOUL.md
    notes/
  otheragent/
    config.json
    SOUL.md
    notes/
```

Run simultaneously with different `AGENT=` env vars and different bot tokens.

## Configuration

All settings live in a single `config.json` file per agent (gitignore it — it contains secrets):

```json
{
  "name": "MyAgent",
  "model": "claude-sonnet-4-6",
  "timezone": "America/New_York",
  "telegram": {
    "token": "YOUR_BOT_TOKEN",
    "allowedUsers": [123456789]
  },
  "openrouterKey": "sk-or-..."
}
```

| Field | Required | Description |
|---|---|---|
| `name` | yes | Display name |
| `model` | no | Anthropic model ID (default: `claude-sonnet-4-6`) |
| `timezone` | no | IANA timezone (default: system timezone) |
| `telegram.token` | yes | Bot token from @BotFather |
| `telegram.allowedUsers` | yes | Telegram user ID whitelist |
| `openrouterKey` | no | OpenRouter API key (enables Gemini compaction) |

## Telegram Commands

| Command | Description |
|---|---|
| `/help` | Show available commands |
| `/clear` `/reset` `/new` | Clear conversation history |
| `/status` | Agent name, model, session ID, current commit |
| `/model <id>` | Switch model (e.g. `/model claude-opus-4-6`) |
| `/update` | Pull latest code, build, and restart |
| `/build` | Rebuild and restart (no git pull) |

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
AGENT=myagent npm run scheduler       # dev
AGENT=myagent npm run start:scheduler # production
```

Hot-reload schedule without restarting: `kill -HUP <scheduler-pid>`

## Skills

Skills are markdown docs that teach the agent about available CLI tools:

```bash
npm run skill -- list
npm run skill -- install github
npm run skill -- remove github
```

Available skills are in `skills/` — each has a `skill.md` describing commands and usage.

## Architecture

```
src/
  core/                 Agent brain and shared modules
    agent.ts            SDK query interface, session ID persistence
    agentbox.ts         Singleton — all connections talk through this
    auth.ts             Claude Code OAuth credential loading
    config.ts           Config loader (single config.json per agent)
    skills.ts           Skill parsing & manifest generation
    workspace.ts        System prompt builder (preamble + SOUL + skills + notes)

  connections/
    telegram.ts         Telegram (grammY) — streaming, commands, file uploads

  daemon/
    scheduler.ts        Cron daemon with isolated per-task agents

  cli/
    create.ts           agentbox-create onboarding wizard
    skill.ts            agentbox-skill manager

  entrypoints/
    telegram.ts         Boot script for Telegram
```

## License

ISC
