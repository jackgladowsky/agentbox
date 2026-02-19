# docker

Build, run, and manage containers on jacks-server.

## Environment

- Docker 28.x installed at `/usr/bin/docker`
- User `jack` is in the `docker` group — no sudo needed
- Compose files typically live alongside the project they serve

## Useful Patterns

### Run a service with compose
```bash
docker compose -f /path/to/docker-compose.yml up -d
docker compose -f /path/to/docker-compose.yml down
docker compose -f /path/to/docker-compose.yml logs -f
```

### Build and run a one-off image
```bash
docker build -t myapp .
docker run -d --name myapp -p 3000:3000 --restart unless-stopped myapp
```

### Inspect / debug
```bash
docker ps -a                          # all containers including stopped
docker logs -f <container>            # follow logs
docker exec -it <container> /bin/sh   # shell into running container
docker inspect <container>            # full config dump
docker stats                          # live resource usage
```

### Cleanup
```bash
docker system prune -f                # remove stopped containers, dangling images
docker volume prune -f                # remove unused volumes
```

### Common port mapping patterns
```bash
-p 8080:80        # host:container
-p 127.0.0.1:8080:80  # bind to localhost only (safer for internal services)
```

### Persistent volumes
```bash
-v /host/path:/container/path         # bind mount
-v myvolume:/container/path           # named volume (managed by docker)
```

## Currently Running Containers

Check with: `docker ps`

Known services:
- **searxng** — port 8888, used by the search skill

## Notes

- Prefer `--restart unless-stopped` for any long-running service
- Use bind mounts for config files you want to edit; named volumes for data
- `docker compose` (v2, no hyphen) is installed — use this over `docker-compose`
