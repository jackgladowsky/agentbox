#!/usr/bin/env bash
# code-task.sh — delegate a coding task to Claude Code in a git worktree
# Usage: code-task.sh <repo-path> <branch-name> <task-description>
#
# Example:
#   code-task.sh /home/jack/agentbox feat/rate-limiting "add rate limiting to Telegram handler"

set -euo pipefail

REPO="${1:?Usage: code-task.sh <repo-path> <branch-name> <task>}"
BRANCH="${2:?Missing branch name}"
TASK="${3:?Missing task description}"

REPO_NAME="$(basename "$REPO")"
WORKTREE="/tmp/worktrees/${REPO_NAME}/${BRANCH//\//-}"
GH_REPO="$(git -C "$REPO" remote get-url origin | sed 's/.*github.com[:/]//' | sed 's/\.git$//')"

echo "=== coding skill ==="
echo "Repo:      $REPO"
echo "Branch:    $BRANCH"
echo "Worktree:  $WORKTREE"
echo "GH Repo:   $GH_REPO"
echo "Task:      $TASK"
echo ""

# --- 1. Create worktree ---
echo "[1/6] Creating worktree..."
mkdir -p "$(dirname "$WORKTREE")"
git -C "$REPO" worktree add "$WORKTREE" -b "$BRANCH"

# --- 2. Run Claude Code ---
echo "[2/6] Running Claude Code..."
CLAUDE_OUTPUT=$(claude -p --dangerously-skip-permissions \
  --add-dir "$WORKTREE" \
  "You are implementing a coding task in a git worktree at: $WORKTREE

Task: $TASK

Instructions:
- Implement the task completely
- Write or update tests as appropriate  
- Run the test suite (npm test, make test, etc.) and fix any failures
- Do NOT run git commands — the script handles commits
- When done, output a brief summary of what you changed and what tests passed" \
  2>&1)

echo "$CLAUDE_OUTPUT"
echo ""

# --- 3. Run tests ---
echo "[3/6] Running tests..."
TEST_OUTPUT=""
TEST_PASSED=true

cd "$WORKTREE"
if [ -f "package.json" ] && grep -q '"test"' package.json; then
  TEST_OUTPUT=$(npm test 2>&1) || TEST_PASSED=false
  echo "$TEST_OUTPUT"
elif [ -f "Makefile" ] && grep -q "^test:" Makefile; then
  TEST_OUTPUT=$(make test 2>&1) || TEST_PASSED=false
  echo "$TEST_OUTPUT"
else
  echo "(no test runner detected — skipping)"
  TEST_OUTPUT="No test runner detected."
fi
cd - > /dev/null

# --- 4. Commit ---
echo "[4/6] Committing..."
git -C "$WORKTREE" add -A
if git -C "$WORKTREE" diff --cached --quiet; then
  echo "Nothing to commit — Claude Code may not have made changes"
  git -C "$REPO" worktree remove "$WORKTREE" --force
  exit 1
fi
git -C "$WORKTREE" commit -m "${BRANCH%%/*}: $TASK"

# --- 5. Push ---
echo "[5/6] Pushing branch..."
git -C "$WORKTREE" push -u origin "$BRANCH"

# --- 6. Open PR ---
echo "[6/6] Opening PR..."

if [ "$TEST_PASSED" = true ]; then
  TEST_STATUS="✅ Tests passed"
else
  TEST_STATUS="⚠️ Tests failed — review carefully"
fi

PR_BODY="Implemented by Claude Code subagent via coding skill.

## Task
$TASK

## Implementation Summary
$CLAUDE_OUTPUT

## Tests
$TEST_STATUS

\`\`\`
$TEST_OUTPUT
\`\`\`

---
🤖 Auto-generated — review before merging"

PR_URL=$(gh pr create \
  --repo "$GH_REPO" \
  --head "$BRANCH" \
  --base "main" \
  --title "$TASK" \
  --body "$PR_BODY" \
  2>&1)

echo ""
echo "=== Done ==="
echo "PR: $PR_URL"
echo ""
echo "To clean up after merge:"
echo "  git -C $REPO worktree remove $WORKTREE"
echo "  git -C $REPO branch -d $BRANCH"
