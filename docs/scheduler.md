# Scheduler

Rex can run tasks autonomously on a schedule — no user message required. The scheduler is a separate process from the Telegram bot; they share no agent state.

## Architecture

```
rex.service          ← Telegram bot (responds to messages)
rex-scheduler.service ← Scheduler daemon (runs cron tasks)
```

Each scheduled task gets **its own fresh agent instance**. Tasks cannot see each other's outputs or the Telegram conversation history.

## Files

| Path | Purpose |
|---|---|
| `src/scheduler.ts` | Scheduler daemon entrypoint |
| `~/.agentbox/rex/schedule.json` | Task definitions |
| `~/.agentbox/rex/scheduler.log` | Append-only log |
| `systemd/rex-scheduler.service` | systemd unit file |

## schedule.json

```json
{
  "tasks": [
    {
      "id": "my-task",
      "name": "Human-readable name",
      "schedule": "0 4 * * *",
      "prompt": "The prompt sent to the agent.",
      "notify": true
    }
  ]
}
```

### Task fields

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique identifier (used in logs) |
| `name` | string | Display name |
| `schedule` | string | Cron expression (5-field, standard syntax) |
| `prompt` | string | Prompt sent to a fresh agent instance |
| `notify` | `true` \| `false` \| `"on_issue"` | When to send a Telegram notification |

### `notify` modes

- `true` — always send a notification when the task finishes
- `false` — never send a notification (silent)
- `"on_issue"` — only notify if the task fails **or** the output contains keywords like `error`, `warning`, `down`, `critical`, `fail`, `alert`

## Running

**Development:**
```bash
AGENT=rex npx tsx src/scheduler.ts
```

**As a service** (after filling in paths in the unit file):
```bash
# Copy unit file to systemd user dir
cp systemd/rex-scheduler.service ~/.config/systemd/user/

# Edit paths in the unit file
nano ~/.config/systemd/user/rex-scheduler.service

# Enable and start
systemctl --user daemon-reload
systemctl --user enable rex-scheduler
systemctl --user start rex-scheduler

# Check logs
journalctl --user -u rex-scheduler -f
# or
tail -f ~/.agentbox/rex/scheduler.log
```

## Default tasks

Three tasks are pre-configured in `~/.agentbox/rex/schedule.json`:

| Task | Schedule | Notify |
|---|---|---|
| Daily Memory Commit | `0 4 * * *` (04:00 daily) | always |
| System Health Check | `*/30 * * * *` (every 30 min) | on issue only |
| Agentbox Git Sync | `0 * * * *` (hourly) | never |

## Telegram notifications

Notifications are sent as plain `sendMessage` calls to the Telegram Bot API — no bot framework is spun up. The recipient is the first user ID in `config.json`'s `telegram.allowedUsers` array.

```json
{
  "telegram": {
    "token": "YOUR_BOT_TOKEN",
    "allowedUsers": [123456789]
  }
}
```

## Adding a new task

1. Edit `~/.agentbox/rex/schedule.json`
2. Add a new entry to the `tasks` array
3. Restart the scheduler: `systemctl --user restart rex-scheduler`

The scheduler validates cron expressions on startup and skips any malformed ones with a log warning. A bad task definition won't crash the daemon.
