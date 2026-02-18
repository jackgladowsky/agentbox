# coding

Delegate coding tasks to Claude Code in an isolated git worktree. Implements, tests, commits, and opens a PR for manual review. Nothing merges without Jack's approval.

## CLI
- **Type:** prebuilt
- **Binary:** `claude` + `git` + `gh`
- **Install:** Claude Code is already installed at `~/.nvm/versions/node/v22.21.0/bin/claude`

## Auth
- **Required:** yes
- **Method:** Claude Code OAuth (shared with Rex), GitHub CLI OAuth
- **Notes:** Both `claude` and `gh` must already be authenticated

## Depends On
- git
- github

## Workflow

```
repo + task description
  → create worktree on new branch
  → claude -p implements + tests
  → run tests
  → commit all changes
  → push branch
  → gh pr create
  → return PR URL to Rex
```

## Commands

### Full task (most common)
```bash
# From inside the target repo dir:
REPO=/home/jack/agentbox
TASK="add rate limiting to the Telegram message handler"
BRANCH="feat/rate-limiting"

# 1. Create worktree
WORKTREE="/tmp/worktrees/$(basename $REPO)/$BRANCH"
git -C "$REPO" worktree add "$WORKTREE" -b "$BRANCH"

# 2. Run Claude Code in the worktree
claude -p --dangerously-skip-permissions \
  --add-dir "$WORKTREE" \
  "You are implementing a coding task in a git worktree. The repo is at $WORKTREE.

Task: $TASK

Instructions:
- Implement the task completely
- Write or update tests as appropriate
- Run the test suite and fix any failures before finishing
- Do NOT commit — leave that to the script
- When done, output a one-line summary of what you changed" \
  2>&1

# 3. Run tests (repo-specific — check package.json / Makefile)
cd "$WORKTREE" && npm test 2>&1

# 4. Commit
git -C "$WORKTREE" add -A
git -C "$WORKTREE" commit -m "feat: $TASK"

# 5. Push
git -C "$WORKTREE" push -u origin "$BRANCH"

# 6. Open PR
gh pr create \
  --repo "jackgladowsky/agentbox" \
  --head "$BRANCH" \
  --base "main" \
  --title "$TASK" \
  --body "Implemented by Claude Code subagent via coding skill.

## Task
$TASK

## Changes
(see diff)

## Tests
All tests passed before PR was opened.

---
🤖 Auto-generated — review before merging"
```

### Cleanup after merge/close
```bash
REPO=/home/jack/agentbox
BRANCH="feat/rate-limiting"
WORKTREE="/tmp/worktrees/$(basename $REPO)/$BRANCH"

git -C "$REPO" worktree remove "$WORKTREE"
git -C "$REPO" branch -d "$BRANCH"
```

### List active worktrees
```bash
git -C /home/jack/agentbox worktree list
```

## Usage Pattern (how Rex uses this)

Rex receives a task → constructs the command sequence above → executes it → reports the PR URL back to Jack. Rex does **not** review or merge the PR. That's Jack's job.

## Branch Naming Convention
- `feat/<slug>` — new feature
- `fix/<slug>` — bug fix
- `refactor/<slug>` — refactor, no behavior change
- `chore/<slug>` — deps, config, tooling

## Notes
- Worktrees live in `/tmp/worktrees/` — ephemeral, cleaned up after merge
- `--dangerously-skip-permissions` is intentional: Claude Code runs autonomously in an isolated worktree, not on main
- If tests fail, the PR is still opened but marked with a ⚠️ in the body
- Claude Code uses the shared OAuth credentials — same billing as Rex
