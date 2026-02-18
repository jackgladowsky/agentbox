# Skills

Rex's modular capabilities. Each skill is a folder with a single `skill.md` describing the CLI tool, how to install it, auth requirements, and key commands.

## Structure

```
skills/
  <skill-name>/
    skill.md          ← everything lives here
  my-custom-cli/
    skill.md          ← references the external git repo for the CLI
```

Custom CLIs are their own git repos. `skill.md` just links to them — no code lives here.

## skill.md Template

```markdown
# <name>

Short description.

## CLI
- **Type:** prebuilt | custom
- **Binary:** `<binary>`
- **Install:** `<command>`
- **Repo:** <git url>  ← custom CLIs only

## Auth
- **Required:** yes | no
- **Method:** oauth | token | ssh_key | password
- **Env:** `VAR_NAME`
- **Notes:** ...

## Depends On
- <other skill name>

## Commands
- `<example command>`
```

## Skills

| Skill | Type | Binary | Auth |
|---|---|---|---|
| git | prebuilt | `git` | no |
| github | prebuilt | `gh` | yes |
| docker | prebuilt | `docker` | optional |
| vercel | prebuilt | `vercel` | yes |
| restic | prebuilt | `restic` | yes |
