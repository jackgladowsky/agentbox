# github

GitHub CLI — manage repos, PRs, issues, releases, and Actions.

## CLI
- **Type:** prebuilt
- **Binary:** `gh`
- **Install:** `sudo apt install gh`

## Auth
- **Required:** yes
- **Method:** OAuth / token
- **Env:** `GITHUB_TOKEN`
- **Notes:** Run `gh auth login` or set `GITHUB_TOKEN`

## Depends On
- git

## Commands
- `gh repo clone <owner>/<repo>`
- `gh pr list`
- `gh pr create --title <title> --body <body>`
- `gh issue create --title <title> --body <body>`
- `gh workflow run <workflow>`
- `gh release create <tag> --notes <notes>`
