# docker

Build, run, and manage containers.

## CLI
- **Type:** prebuilt
- **Binary:** `docker`
- **Install:** `sudo apt install docker.io`

## Auth
- **Required:** only for private registries
- **Env:** `DOCKER_USERNAME`, `DOCKER_PASSWORD`

## Depends On
- none

## Commands
- `docker build -t <name> .`
- `docker run -d --name <name> <image>`
- `docker ps`
- `docker logs -f <container>`
- `docker compose up -d`
- `docker compose down`
