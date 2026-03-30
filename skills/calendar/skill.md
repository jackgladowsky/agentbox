# calendar

Read Google Calendar events using `gcalcli`.

## CLI
- **Type:** prebuilt
- **Binary:** `gcalcli`
- **Install:** `pip install gcalcli`

## Auth
- **Required:** yes
- **Method:** oauth
- **Notes:** run `gcalcli list` once on the server to complete the first-run OAuth flow and cache credentials locally

## Commands
```bash
# Today's events
gcalcli agenda "today" "tomorrow"

# Next 7 days
gcalcli agenda "today" "+7d"

# Search for a specific event
gcalcli search "office hours"

# Weekly calendar view
gcalcli calw 1
```

## Usage Notes
- Use `agenda "today" "tomorrow"` when the user asks what’s on today.
- Use `search` for questions like "when is office hours" or "do I have advising this week?"
- `gcalcli` output is already readable; summarize it instead of pasting long blocks unless the user asks.
- Calendar access is read-only for now.
