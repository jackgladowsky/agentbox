#!/usr/bin/env bash
# search — web search skill for AgentBox
# Backend: self-hosted SearXNG (swappable, see BACKEND section)
# Usage: search <query> [--results N] [--format json|text] [--backend searxng|ddg]

set -euo pipefail

# ── BACKEND CONFIG (swap this out to change providers) ──────────────────────
# Options:
#   searxng  — self-hosted SearXNG on jacks-server (default, fast, no rate limits)
#   ddg      — DuckDuckGo lite scrape (fallback, may get blocked)
BACKEND="${SEARCH_BACKEND:-searxng}"

# Self-hosted SearXNG — running on jacks-server:8888
SEARXNG_INSTANCE="${SEARXNG_INSTANCE:-http://localhost:8888}"
# ────────────────────────────────────────────────────────────────────────────

RESULTS=5
FORMAT="text"
QUERY=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --results|-n) RESULTS="$2"; shift 2 ;;
    --format|-f)  FORMAT="$2";  shift 2 ;;
    --backend|-b) BACKEND="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: search <query> [--results N] [--format json|text] [--backend searxng|ddg]"
      echo ""
      echo "Backends:"
      echo "  searxng  Self-hosted SearXNG at localhost:8888 (default)"
      echo "  ddg      DuckDuckGo lite scrape (fallback)"
      echo ""
      echo "Env vars:"
      echo "  SEARCH_BACKEND     Override default backend"
      echo "  SEARXNG_INSTANCE   Override SearXNG URL (default: http://localhost:8888)"
      exit 0
      ;;
    *) QUERY="${QUERY:+$QUERY }$1"; shift ;;
  esac
done

if [[ -z "$QUERY" ]]; then
  echo "Error: no query provided" >&2
  echo "Usage: search <query>" >&2
  exit 1
fi

# ── BACKENDS ────────────────────────────────────────────────────────────────

search_searxng() {
  local encoded
  encoded=$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1]))" "$QUERY")

  local url="${SEARXNG_INSTANCE}/search?q=${encoded}&format=json&categories=general"

  local response
  response=$(curl -sf \
    -H "Accept: application/json" \
    --max-time 15 \
    "$url") || { echo "Error: SearXNG request failed (is Docker container running?)" >&2; exit 1; }

  if [[ "$FORMAT" == "json" ]]; then
    echo "$response" | python3 -c "
import json, sys
data = json.load(sys.stdin)
results = data.get('results', [])[:${RESULTS}]
print(json.dumps(results, indent=2))
"
  else
    echo "$response" | python3 -c "
import json, sys, textwrap
data = json.load(sys.stdin)
results = data.get('results', [])[:${RESULTS}]
if not results:
    print('No results found.')
    sys.exit(0)
for i, r in enumerate(results, 1):
    print(f\"{i}. {r.get('title', 'No title')}\")
    print(f\"   {r.get('url', '')}\")
    content = r.get('content', '').strip()
    if content:
        for line in textwrap.wrap(content, width=76):
            print(f'   {line}')
    print()
"
  fi
}

search_ddg() {
  local encoded
  encoded=$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1]))" "$QUERY")

  local response
  response=$(curl -sf \
    -H "User-Agent: Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/115.0" \
    -L --max-time 15 \
    "https://lite.duckduckgo.com/lite/?q=${encoded}") || { echo "Error: DDG request failed" >&2; exit 1; }

  echo "$response" | python3 -c "
import sys, re, html, textwrap

text = sys.stdin.read()
titles = re.findall(r'class=\"result-link\"[^>]*>([^<]+)<', text)
urls   = re.findall(r'href=\"(https?://[^\"]+)\"', text)
snips  = re.findall(r'class=\"result-snippet\"[^>]*>(.*?)</td>', text, re.DOTALL)

count = 0
for i, (title, url, snip) in enumerate(zip(titles, urls, snips), 1):
    if count >= ${RESULTS}: break
    snip_clean = re.sub(r'<[^>]+>', '', snip).strip()
    snip_clean = html.unescape(snip_clean)
    print(f'{i}. {html.unescape(title.strip())}')
    print(f'   {url}')
    if snip_clean:
        for line in textwrap.wrap(snip_clean, width=76):
            print(f'   {line}')
    print()
    count += 1

if count == 0:
    print('No results found (DDG may be blocking this IP).')
"
}

# ── DISPATCH ────────────────────────────────────────────────────────────────

case "$BACKEND" in
  searxng) search_searxng ;;
  ddg)     search_ddg ;;
  *)
    echo "Error: unknown backend '$BACKEND'. Options: searxng, ddg" >&2
    exit 1
    ;;
esac
