# Task: rex-skill CLI

## Goal
Build a custom CLI tool called `rex-skill` that Rex (and humans) can use to manage skills. This is both a useful tool AND a proof-of-concept for the "custom CLIs as their own repos" pattern in the skills system.

## Context
- Codebase: `/home/jack/agentbox-skills-cli` (git worktree of agentbox, branch `feat/skills-cli`)
- Skills live in: `/home/jack/agentbox/skills/<name>/skill.md`
- Skills README: `/home/jack/agentbox/skills/README.md`
- Pattern: custom CLIs should be their own git repos — but for now build it IN agentbox and we'll extract later

## What to Build

### `src/rex-skill.ts` — The CLI entrypoint
A proper CLI using `process.argv` parsing (no heavy framework needed, keep it simple).

**Commands:**

```bash
rex-skill list                    # List all skills with status
rex-skill status                  # Same as list but more verbose
rex-skill show <name>             # Print the full skill.md for a skill
rex-skill install <name>          # Run the install command for a skill
rex-skill check                   # Check which skills are installed vs missing
rex-skill add <name>              # Scaffold a new skill.md from template
```

**`rex-skill list` output:**
```
✅ git        prebuilt  no auth    git
✅ github     prebuilt  auth req   gh
✅ docker     prebuilt  opt auth   docker
❌ vercel     prebuilt  auth req   vercel  (not installed)
❌ restic     prebuilt  auth req   restic  (not installed)
```

**`rex-skill check` output:**
```
Installed:   git, github, docker
Missing:     vercel, restic
Needs auth:  github (GITHUB_TOKEN not set)
```

**`rex-skill install <name>` behavior:**
- Read the skill.md, parse the install command
- Print it clearly and ask for confirmation (y/N)
- If confirmed, execute it
- Verify the binary exists afterward

**`rex-skill add <name>` behavior:**
- Create `skills/<name>/skill.md` with the template filled in minimally
- Print the path so user knows where to edit

### Parsing skill.md
Write a simple markdown parser that extracts:
- Name (from `# heading`)
- CLI type (prebuilt/custom)
- Binary name
- Install command
- Auth required (yes/no)
- Env vars

No fancy libraries — just regex/split on the structured markdown we defined.

### `package.json` — Add bin entry
```json
"bin": {
  "rex-skill": "./src/rex-skill.ts"
}
```

And add a script:
```json
"rex-skill": "tsx src/rex-skill.ts"
```

### `skills/rex-skill/skill.md` — Self-describing skill entry
The rex-skill CLI should have its own skill.md:
```markdown
# rex-skill

Rex's built-in skill manager CLI. List, check, install, and scaffold skills.

## CLI
- **Type:** custom
- **Binary:** `rex-skill`
- **Repo:** https://github.com/jackgladowsky/agentbox (src/rex-skill.ts)

## Auth
- **Required:** no

## Depends On
- none

## Commands
- `rex-skill list`
- `rex-skill check`
- `rex-skill show <name>`
- `rex-skill install <name>`
- `rex-skill add <name>`
```

## Requirements
- Zero new npm dependencies (use Node built-ins: fs, path, child_process, readline)
- Works with `npx tsx src/rex-skill.ts list` 
- Parses skill.md correctly for all 5 existing skills
- Clean, readable output with emoji status indicators
- TypeScript, ESM

## Definition of Done
- [ ] `src/rex-skill.ts` compiles and runs
- [ ] `rex-skill list` shows all 5 skills with correct status
- [ ] `rex-skill check` correctly identifies installed vs missing binaries
- [ ] `rex-skill show github` prints the github skill.md
- [ ] `rex-skill add test-skill` creates a scaffolded skill.md
- [ ] `skills/rex-skill/skill.md` exists
- [ ] npm script added to package.json
- [ ] All changes committed to branch `feat/skills-cli`
