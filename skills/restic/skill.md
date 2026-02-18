# restic

Fast, encrypted, deduplicated backups.

## CLI
- **Type:** prebuilt
- **Binary:** `restic`
- **Install:** `sudo apt install restic`

## Auth
- **Required:** yes
- **Method:** password
- **Env:** `RESTIC_REPOSITORY`, `RESTIC_PASSWORD`

## Depends On
- none

## Commands
- `restic init`
- `restic backup <path>`
- `restic snapshots`
- `restic restore latest --target <path>`
- `restic forget --keep-daily 7 --keep-weekly 4 --prune`
