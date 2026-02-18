# search

Web search skill — query the web and get results back as text or JSON.

## CLI
- **Type:** custom script
- **Binary:** `skills/search/search.sh`
- **Install:** none — uses curl + python3

## Infrastructure
- **SearXNG** running in Docker on jacks-server, port 8888
- Started with: `docker run -d --name searxng -p 8888:8080 -v skills/search/searxng-config:/etc/searxng --restart unless-stopped searxng/searxng:latest`
- Config: `skills/search/searxng-config/settings.yml`

## Backend
Swappable via `--backend` flag or `SEARCH_BACKEND` env var:

| Backend | Description | Default |
|---------|-------------|---------|
| `searxng` | Self-hosted SearXNG at localhost:8888 | ✅ |
| `ddg` | DuckDuckGo Lite scrape (fallback) | |

**To swap the SearXNG instance:**
```bash
export SEARXNG_INSTANCE=http://localhost:8888  # default
```

**To use DDG instead:**
```bash
search "query" --backend ddg
# or permanently:
export SEARCH_BACKEND=ddg
```

## Commands
```bash
# Basic search
search <query>

# Limit results (default: 5)
search <query> --results 3

# JSON output
search <query> --format json

# Use DDG fallback
search <query> --backend ddg
```

## Depends On
- Docker (for SearXNG container)
- curl
- python3 (stdlib only)

## Notes
- Public SearXNG instances rate-limit server IPs aggressively — self-hosting avoids this entirely
- DDG also blocks server IPs, use only as last resort
- SearXNG aggregates Google, Bing, DDG simultaneously
