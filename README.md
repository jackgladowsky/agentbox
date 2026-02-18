# AgentBox

An autonomous AI agent runtime for dedicated hardware. Not a chatbot. Not a cloud service. An agent that runs on your machine, owns its environment, and actually does things.

## What It Is

AgentBox gives Claude a persistent home on your hardware:

- **Telegram interface** — talk to your agent from anywhere, with live streaming responses
- **Full shell access** — the agent can run commands, read/write files, install packages, manage processes
- **Persistent memory** — notes survive across sessions; the agent builds context about your system over time
- **Multi-agent support** — run multiple named agents on the same machine, each with their own identity and config
- **Claude Code OAuth** — uses your existing Claude Pro/Max subscription, no separate API billing

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
```

### Create your agent

Each agent lives in `~/.agentbox/<agent-name>/`. Create a config:

```bash
mkdir -p ~/.agentbox/myagent

cat > ~/.agentbox/myagent/config.json << 'EOF'
{
  "name": "MyAgent",
  "telegram": {
    "token": "YOUR_BOT_TOKEN",
    "allowedUsers": [YOUR_TELEGRAM_USER_ID]
  }
}
EOF
```

Optionally give your agent a personality:

```bash
cat > ~/.agentbox/myagent/SOUL.md << 'EOF'
You are MyAgent. You are direct, curious, and get things done.
...
EOF
```

The agent will also maintain its own `~/.agentbox/myagent/notes/` directory for persistent memory across sessions.

### Authenticate Claude

If you haven't already:

```bash
npm install -g @anthropic-ai/claude-code
claude  # follow the OAuth flow
```

## Running

```bash
# Run with a specific agent
AGENT=myagent npm run telegram

# Or via systemd (recommended for always-on)
cp systemd/agentbox.service ~/.config/systemd/user/myagent.service
# Edit paths and AGENT= in myagent.service
systemctl --user enable --now myagent
```

## Multiple Agents

Each agent is fully isolated — separate identity, config, tokens, and memory:

```
~/.agentbox/
  myagent/
    config.json     ← name, model, telegram token, allowed users
    SOUL.md         ← personality / system prompt
    notes/          ← persistent memory (auto-managed by agent)
  otheragent/
    config.json
    SOUL.md
    notes/
```

Run them simultaneously with different `AGENT=` env vars and different bot tokens.

## Agent Config Reference

`~/.agentbox/<name>/config.json`:

```json
{
  "name": "MyAgent",
  "model": "claude-sonnet-4-6",
  "telegram": {
    "token": "YOUR_BOT_TOKEN",
    "allowedUsers": [123456789]
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Display name used in responses |
| `model` | no | Anthropic model ID (default: `claude-sonnet-4-6`) |
| `telegram.token` | yes | Bot token from @BotFather |
| `telegram.allowedUsers` | yes | Telegram user ID whitelist |

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` or `/help` | Show available commands |
| `/clear` | Clear conversation history |
| `/status` | Show agent name, model, message count |
| `/model <id>` | Switch model (e.g. `/model claude-opus-4-5`) |
| `/thinking` | Toggle extended thinking on/off |

Send text, images, files, or voice messages — all supported.

## Architecture

```
src/
  agent.ts              # Agent setup, tools (shell, read_file, write_file, list_dir)
  agentbox.ts           # Singleton AgentBox instance, connection-agnostic
  config.ts             # Agent config loader (~/.agentbox/<name>/)
  auth.ts               # Claude Code OAuth credential loading
  workspace.ts          # System prompt builder (preamble + SOUL.md + notes/)
  connections/
    telegram.ts         # Telegram adapter (grammY)
    tui.tsx             # Terminal UI adapter (Ink)
  telegram.ts           # Telegram entrypoint
  index.tsx             # TUI entrypoint
```

Connections are adapters over the AgentBox singleton. Adding a new interface (Discord, Slack, etc.) means writing a new adapter in `src/connections/`.

## Philosophy

See [VISION.md](./VISION.md) for the full picture.

The short version: most AI agents are constrained by design. AgentBox starts from the opposite assumption — real autonomy, explicit security, technical users only.

## License

ISC
