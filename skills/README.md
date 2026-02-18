# Skills

Skills are Rex's modular capabilities. Each skill wraps a CLI tool — either a prebuilt one (like `gh`, `vercel`, `docker`) or a custom one we build.

## Structure

```
skills/
  <skill-name>/
    skill.json     ← metadata, auth requirements, commands
  skill.template.json  ← copy this to start a new skill
```

## skill.json Fields

| Field | Description |
|---|---|
| `name` | Unique identifier |
| `description` | What it does |
| `cli.type` | `prebuilt` (existing CLI) or `custom` (we build it) |
| `cli.binary` | The binary name (e.g. `gh`, `vercel`) |
| `cli.install` | How to install it (method + command) |
| `auth.required` | Does it need credentials? |
| `auth.method` | `oauth`, `token`, `ssh_key`, `password` |
| `auth.env_vars` | Env vars Rex checks to determine auth status |
| `depends_on` | Other skill names this one requires |
| `commands` | Key operations exposed to Rex |
| `status` | Runtime-resolved: `installed`, `not_installed`, `needs_auth` |

## Current Skills

| Skill | CLI | Status |
|---|---|---|
| git | `git` | ✅ prebuilt, installed |
| github | `gh` | ✅ prebuilt, installed |
| docker | `docker` | ✅ prebuilt, installed |
| vercel | `vercel` | ❌ not installed (`npm i -g vercel`) |
| restic | `restic` | ❌ not installed (`sudo apt install restic`) |

## Adding a Skill

1. Copy `skill.template.json` to `skills/<name>/skill.json`
2. Fill in the fields
3. The runtime auto-discovers it on next load — no registration needed

## Custom Skills

If no prebuilt CLI exists, build one. Put the binary in `skills/<name>/bin/` and set `cli.type: "custom"`. The install method can point to a local build script.
