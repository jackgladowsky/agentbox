# Contributing to AgentBox

AgentBox is a runtime for autonomous AI agents on dedicated hardware. This doc covers the architecture, how things fit together, and how to extend it.

---

## Architecture Overview

```
src/
  core/               Core runtime — the agent brain and all shared modules
    agent.ts          Agent factory, tool definitions, context compaction
    agentbox.ts       Singleton AgentBox instance (connections talk to this)
    auth.ts           Claude Code OAuth credential loading
    checkpoint.ts     Persist/restore message history across restarts
    config.ts         Load ~/.agentbox/<name>/config.json + secrets.json
    memory.ts         Idle-triggered write-back of session notes
    workspace.ts      System prompt builder (preamble + SOUL.md + notes/)

  connections/        Interface adapters — each one talks to the AgentBox singleton
    telegram.ts       Telegram adapter (grammY) — streaming, commands, file uploads
    tui.tsx           Terminal UI adapter (Ink) — interactive local interface

  daemon/
    scheduler.ts      Standalone cron daemon — runs scheduled tasks with isolated agents

  cli/
    create.ts         agentbox-create — onboarding wizard for new agents
    skill.ts          agentbox-skill — skill install/remove/list CLI

  entrypoints/
    telegram.ts       Boot: auth → init agentbox → start Telegram connection
    tui.tsx           Boot: auth → init agentbox → start TUI
```

### Key Concepts

**AgentBox singleton** (`core/agentbox.ts`)
- Single agent instance shared across all connections
- Queues messages so connections don't clobber each other
- Pub/sub for agent events — connections subscribe and receive streaming deltas
- `markActivity()` signals real user messages (triggers memory idle timer reset)

**Connections** (`connections/`)
- Stateless adapters over the singleton
- Subscribe to agent events, forward streamed text to their interface
- Handle interface-specific commands (/clear, /model, etc.)
- Adding a new interface = adding one file here

**Config + Secrets** (`core/config.ts`)
- Each agent lives in `~/.agentbox/<name>/`
- `config.json` — name, model, non-sensitive settings (safe to commit)
- `secrets.json` — tokens, API keys (gitignored, never commit)
- `SOUL.md` — personality / system prompt
- `notes/` — persistent memory loaded into every system prompt

**Context Compaction** (`core/agent.ts`)
- Triggers at 400K chars of history
- Summarizes entire transcript with Gemini 2.5 Flash Lite via OpenRouter (1M context)
- Replaces all history with a single `[CONTEXT_COMPACTED]` summary message
- Falls back to trimming oldest messages if no OpenRouter key configured

**Scheduler** (`daemon/scheduler.ts`)
- Completely separate process from the Telegram bot
- Each task gets a fresh isolated agent — no shared state with conversations
- Config: `~/.agentbox/<name>/schedule.json`
- Hot-reloads on SIGHUP — no restart needed to pick up schedule changes

---

## How to Add a New Connection

A connection is an adapter that sends user input to the AgentBox singleton and renders its streaming output.

**Steps:**

1. Create `src/connections/<name>.ts`
2. Subscribe to agent events via `agentbox.subscribe()`
3. Call `agentbox.prompt(content, source)` for incoming messages
4. Call `agentbox.markActivity()` on every real user message
5. Create `src/entrypoints/<name>.ts` that boots auth → agentbox.init() → your connection

**Minimal example:**

```typescript
// src/connections/myinterface.ts
import { agentbox, type MessageSource } from "../core/agentbox.js";
import { type AgentEvent } from "@mariozechner/pi-agent-core";

const SOURCE: MessageSource = { id: "myinterface:local", label: "MyInterface" };

export async function startMyInterface(): Promise<void> {
  agentbox.subscribe("myinterface", (event: AgentEvent, source) => {
    if (source.internal) return; // ignore memory write-backs etc.
    if (event.type === "text_delta") process.stdout.write(event.delta);
    if (event.type === "agent_end") process.stdout.write("\n");
  });

  // Your input loop here — call agentbox.prompt() on each message
  agentbox.markActivity(); // call this whenever a real user message arrives
  await agentbox.prompt("Hello!", SOURCE);
}
```

**Things to handle in a full connection:**
- Streaming text deltas with live updates
- `/clear` → `agentbox.clearMessages()`
- `/model <id>` → `agentbox.setModel(id)`
- `/status` → `agentbox.name`, `agentbox.messageCount`
- Long message splitting (Telegram has a 4096 char limit, for example)
- Tool call events (show a spinner or status indicator while tools run)

---

## How to Add a Scheduled Task

Tasks live in `~/.agentbox/<name>/schedule.json`:

```json
{
  "tasks": [
    {
      "id": "daily-summary",
      "name": "Daily Summary",
      "schedule": "0 9 * * *",
      "prompt": "Check system health and send me a summary of anything worth knowing.",
      "notify": "on_issue"
    }
  ]
}
```

**Fields:**
| Field | Type | Description |
|---|---|---|
| `id` | string | Unique identifier |
| `name` | string | Human-readable label for logs and notifications |
| `schedule` | string | Cron expression (uses node-cron) |
| `prompt` | string | What to ask the agent |
| `notify` | `true` \| `false` \| `"on_issue"` | When to send a Telegram message with the result |

**`notify` values:**
- `true` — always send the result via Telegram
- `false` — never notify, just log
- `"on_issue"` — only notify if output contains warning/error/fail/alert keywords or the task fails

**Hot-reload:** Send SIGHUP to the scheduler process to reload `schedule.json` without restarting:
```bash
kill -HUP $(systemctl --user show rex-scheduler --property MainPID | cut -d= -f2)
```

---

## How to Add a Skill

Skills are markdown documents that teach the agent about available CLI tools. They live in `skills/` in the agentbox repo.

```
skills/
  github/
    SKILL.md        # What it does, commands, examples
  docker/
    SKILL.md
  myskill/
    SKILL.md
```

**SKILL.md format:**
```markdown
# Skill: My Tool

## What It Does
Brief description.

## Installation
How to install the CLI if needed.

## Commands

### Do a thing
\`\`\`bash
mytool do-thing --flag value
\`\`\`

### Other command
...

## Notes
Anything the agent should know about quirks, auth, etc.
```

**Install/remove via CLI:**
```bash
agentbox-skill install myskill    # copies SKILL.md into agent's loaded skills
agentbox-skill remove myskill
agentbox-skill list
```

---

## How to Fix a Bug

1. `git checkout -b fix/<short-description>`
2. Make the fix
3. `npm run test` — must pass (TypeScript compile check)
4. `npm run build` — verify clean build
5. PR against master

**Common places for common bugs:**
- Agent not responding → `core/agentbox.ts` queue/busy logic
- Context blowing up → `core/agent.ts` compaction, `MAX_CONTEXT_CHARS`
- Config not loading → `core/config.ts` secrets merge logic
- Telegram commands broken → `connections/telegram.ts` command handlers
- Memory write-back not firing → `core/memory.ts` idle timer, marker file in /tmp
- Scheduler tasks not running → `daemon/scheduler.ts` cron registration, SIGHUP handler
- Auth failing → `core/auth.ts`, check `~/.agentbox/credentials.json`

---

## How to Add a New Feature

1. **Figure out which layer it belongs to:**
   - Changes agent behavior / tools → `core/agent.ts` or new file in `core/`
   - New interface → `connections/` + `entrypoints/`
   - Automated background task → `daemon/scheduler.ts` or new daemon
   - New CLI command → `cli/`

2. **Keep the singleton clean** — `core/agentbox.ts` should stay simple. Don't add feature logic there; add it in dedicated modules that use the singleton.

3. **Secrets always go in `secrets.json`** — never `config.json`. The config loading in `core/config.ts` merges them at runtime.

4. **Update this doc** if you add a new layer or pattern.

---

## Running Locally

```bash
# Install deps
npm install

# Type check
npm run test

# Build
npm run build

# Run Telegram bot (needs AGENT env var pointing to a configured agent)
AGENT=myagent npm run telegram        # dev mode (tsx)
AGENT=myagent npm run start:telegram  # production (compiled dist/)

# Run TUI
AGENT=myagent npm run dev

# Run scheduler
AGENT=myagent npm run scheduler
```

## Systemd (Production)

```bash
# Template service file is at systemd/agentbox.service
# Copy and customize for your agent:
cp systemd/agentbox.service ~/.config/systemd/user/myagent.service
# Edit WorkingDirectory, ExecStart, and AGENT= in the file

systemctl --user daemon-reload
systemctl --user enable --now myagent
systemctl --user status myagent
journalctl --user -u myagent -f
```
