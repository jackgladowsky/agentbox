# AgentBox

An autonomous AI agent runtime for dedicated hardware. Not a chatbot. Not a cloud service. An agent that runs on your machine, owns its environment, and actually does things.

## What It Is

AgentBox gives Claude a persistent home on your hardware:

- **Telegram interface** — talk to your agent from anywhere, with live streaming responses
- **Full shell access** — the agent can run commands, read/write files, install packages, manage processes
- **Persistent memory** — notes survive across sessions; the agent builds up context about your system over time
- **Singleton agent** — one agent, shared across all connections. No session fragmentation.
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

### Configure Telegram

```bash
mkdir -p ~/.config/rex
cat > ~/.config/rex/telegram.json << EOF
{
  "token": "YOUR_BOT_TOKEN",
  "allowedUsers": [YOUR_TELEGRAM_USER_ID]
}
EOF
```

`allowedUsers` is a whitelist — anyone not on the list gets silently dropped.

### Authenticate Claude

If you haven't already:

```bash
npm install -g @anthropic-ai/claude-code
claude  # follow the OAuth flow
```

## Running

```bash
# Dev (tsx, hot-ish)
npm run telegram

# Or via systemd (recommended for always-on)
cp systemd/rex.service ~/.config/systemd/user/rex.service
# Edit the paths in rex.service to match your setup
systemctl --user enable --now rex
```

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` or `/help` | Show available commands |
| `/clear` | Clear conversation history |
| `/status` | Show current model and message count |
| `/model <id>` | Switch model (e.g. `/model claude-opus-4-5`) |
| `/thinking` | Toggle extended thinking on/off |

Send text, images, files, or voice messages — all supported.

## Architecture

```
src/
  agent.ts          # Agent setup, tools (shell, read_file, write_file, list_dir)
  rex.ts            # Singleton Rex instance, connection-agnostic
  auth.ts           # Claude Code OAuth credential loading
  workspace.ts      # System prompt / workspace context loader
  connections/
    telegram.ts     # Telegram adapter (grammY)
    tui.tsx         # Terminal UI adapter (Ink)
  telegram.ts       # Telegram entrypoint
  index.tsx         # TUI entrypoint
```

Connections are adapters over the Rex singleton. Adding a new interface (Discord, Slack, etc.) means writing a new adapter — the agent logic stays the same.

## Customizing Your Agent

Edit `SOUL.md` to change the agent's personality, behavior, and identity. This gets loaded as part of the system prompt.

Edit `src/agent.ts` to add or remove tools.

## Notes System

The agent maintains a `notes/` directory as persistent memory — goals, system knowledge, journal entries. These survive context compaction and restarts. The agent reads and updates them autonomously.

> `notes/` is gitignored by default. It's your agent's private state.

## Philosophy

See [VISION.md](./VISION.md) for the full picture.

The short version: most AI agents are constrained by design. AgentBox starts from the opposite assumption — real autonomy, explicit security, technical users only.

## License

ISC
