# reminders

Manage one-shot personal reminders stored locally in `~/.agentbox/<agent>/reminders.json`.

## CLI
- **Type:** custom script
- **Binary:** `skills/reminders/reminders.sh`
- **Install:** none — uses bash + node

## Storage
- **File:** `~/.agentbox/<agent>/reminders.json`
- **Schema:** flat JSON array of reminder objects
- **Reminder fields:** `id`, `message`, `due`, `created`, `status`

## Commands
```bash
# Add a reminder using an absolute ISO datetime
skills/reminders/reminders.sh add --message "Submit HW5" --due "2026-03-31T22:00:00-04:00"

# List all reminders or filter by status
skills/reminders/reminders.sh list
skills/reminders/reminders.sh list --status pending

# Cancel a reminder
skills/reminders/reminders.sh cancel rem_abc123
```

## Scheduler
```bash
# Internal scheduler command: marks past-due pending reminders as fired
skills/reminders/reminders.sh fire-due
```

## Usage Notes
- Resolve natural language times yourself before calling the CLI.
- Use the agent timezone from `~/.agentbox/<agent>/config.json` when converting phrases like "tomorrow at 10pm".
- `due` should be passed as an ISO-8601 datetime string. The script stores it in normalized UTC form.
- When the user asks what’s due today, check pending reminders alongside calendar events and tasks.
- Keep confirmation messages short and include the exact due time.
