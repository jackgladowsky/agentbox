# AgentBox Vision

## What Is It?

AgentBox is a self-contained AI agent runtime designed to run on dedicated hardware. It's a template for giving an AI agent real autonomy — not as a product, but as a starting point for technical users who want to build their own.

Think of it as: **"Here's a computer. Here's an AI. They're yours now."**

## Core Philosophy

### Default-Deny Security
Nothing happens without explicit configuration. No ambient capabilities, no assumed permissions. Every tool, every integration, every action requires intentional opt-in.

- **No tools enabled by default** — you grant what you want
- **No external access by default** — networking, APIs, messaging all require config
- **Audit trail** — know what your agent did and why

### Technical Users Only
This isn't a consumer product. It's for people who:
- Understand what they're giving the AI access to
- Can read and modify the codebase
- Want to customize behavior through code, not UI
- Are comfortable with the risks of autonomous agents

### Self-Development
The agent can modify its own configuration, documentation, and capabilities — within boundaries you set. It learns, adapts, and evolves through use.

### Hardware-Native
Designed to run on a dedicated box (mini PC, homelab server, etc). The agent "owns" its environment. This isn't a cloud service or a Docker container you spin up temporarily.

## What It Does (Capabilities)

### Communication Channels
Configurable integrations for how the agent talks to the world:
- Discord
- WhatsApp
- Telegram
- Signal
- Slack
- Email
- SMS

**All disabled by default.** You enable what you need.

### Skills System
Modular capabilities the agent can use:
- Web browsing and research
- File system access
- Code execution
- API integrations
- Hardware control (cameras, sensors, etc)
- Custom skills you build

Skills are self-documenting (SKILL.md) and can be added/removed as needed.

### Memory & Identity
- Persistent memory across sessions
- Self-maintained documentation
- Evolving identity and preferences
- Journal/logging of activity

### Scheduling & Autonomy
- Heartbeat system for periodic check-ins
- Cron jobs for scheduled tasks
- Proactive actions within defined boundaries

## What Makes It Different From OpenClaw/Clawdbot?

| Aspect | Clawdbot | AgentBox |
|--------|----------|----------|
| Target user | Broader audience | Technical users only |
| Default state | Some capabilities enabled | Everything disabled |
| Security model | Trust-based | Explicit grants |
| Deployment | Cloud/container friendly | Hardware-native |
| Customization | Config files | Full source modification |
| Philosophy | Product | Template |

AgentBox takes inspiration from Clawdbot's architecture (channels, skills, memory) but rebuilds the trust model from scratch.

## Architecture (High Level)

```
┌─────────────────────────────────────────────────┐
│                   AgentBox                       │
├─────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────┐  │
│  │   Channels  │  │   Skills    │  │ Memory  │  │
│  │  (disabled) │  │  (disabled) │  │         │  │
│  └─────────────┘  └─────────────┘  └─────────┘  │
├─────────────────────────────────────────────────┤
│                 Core Runtime                     │
│  - LLM interface (provider-agnostic)            │
│  - Config loader (YAML/TOML)                    │
│  - Permission checker                           │
│  - Audit logger                                 │
├─────────────────────────────────────────────────┤
│               Security Boundary                  │
│  - Explicit capability grants                   │
│  - Action allowlists                            │
│  - Rate limiting                                │
│  - Human-in-the-loop hooks                      │
└─────────────────────────────────────────────────┘
```

## Configuration Model

```yaml
# agentbox.yaml - example config

identity:
  name: "Hex"
  model: "anthropic/claude-sonnet-4"
  
channels:
  discord:
    enabled: true
    token: "${DISCORD_TOKEN}"
    guilds: ["..."]
    
  whatsapp:
    enabled: false
    
skills:
  web_search:
    enabled: true
  file_system:
    enabled: true
    paths: ["/home/agent/workspace"]  # scoped access
  shell:
    enabled: true
    allowlist: ["git", "npm", "python"]  # only these commands
    
security:
  require_confirmation:
    - send_email
    - post_social
    - delete_file
  audit_log: "/var/log/agentbox/audit.log"
  rate_limits:
    messages_per_hour: 100
    api_calls_per_minute: 30
```

## Self-Replication

AgentBox is designed to be cloned:

1. **Fork the template** — start with the base AgentBox
2. **Customize identity** — SOUL.md, AGENTS.md, etc
3. **Configure capabilities** — enable what you need
4. **Deploy to hardware** — your dedicated box
5. **Let it evolve** — agent modifies its own config over time

Each instance becomes unique through use while maintaining the core security model.

## LLM Provider Strategy

**Primary: Claude Code OAuth**

Clawdbot/pi-ai uses Claude Code's OAuth tokens (`sk-ant-oat-*`) with stealth headers to authenticate through Anthropic's API. This lets users leverage their Claude Code subscription without separate API billing.

How it works:
1. User runs `claude` CLI and authenticates (one-time)
2. AgentBox reads the OAuth token from Claude Code's credential store
3. Requests include Claude Code identity headers:
   - `anthropic-beta: claude-code-20250219,oauth-2025-04-20,...`
   - `user-agent: claude-cli/{version} (external, cli)`
   - `x-app: cli`
4. Anthropic API accepts the request as a Claude Code client

**Implementation:**
```typescript
// Core dependency: @mariozechner/pi-ai
// Handles multi-provider streaming, tool calls, thinking blocks
import { streamAnthropic } from "@mariozechner/pi-ai/providers/anthropic";
```

**Fallback options:**
- Direct API keys (ANTHROPIC_API_KEY)
- OpenRouter for multi-model access
- Bedrock for enterprise
- Self-hosted models via OpenAI-compatible API

**For MVP:** Just use Claude Code OAuth. Most technical users already have Claude Pro/Max subscriptions.

---

## Skills = CLI Documentation

Skills in AgentBox document CLIs the agent can use. Each skill is a wrapper around a command-line tool.

**Types of skills:**
1. **Native CLIs** — Document existing tools (gh, vercel, npm, git, docker)
2. **Custom CLIs** — Build our own for agent-specific tasks
3. **Integrations** — Wrap APIs as CLI commands

**Skill structure:**
```
skills/
  github/
    SKILL.md        # What it does, how to use
    commands.yaml   # Available commands, args, examples
  vercel/
    SKILL.md
    commands.yaml
  custom/
    gmail/
      SKILL.md
      cli.ts        # Custom CLI built with Ink
```

**Benefits of CLI-first:**
- Human-testable (just run the command)
- Composable (pipe outputs)
- Sandboxable (restrict which CLIs are available)
- Self-documenting (--help)

**Ink for custom CLIs:**
- Rich terminal UI for interactive flows
- Progress bars, spinners, prompts
- Same runtime as AgentBox core (Node.js)

---

## Agent Notes System

The agent maintains its own understanding through markdown files:

```
notes/
  capabilities.md     # What I can do, what I want
  hardware.md         # My environment, resources
  user.md             # Who I serve, their preferences
  goals.md            # Current objectives, priorities
  journal.md          # Daily log, learnings
```

These are different from memory (conversation history). Notes are the agent's **internal model** of itself and its world.

**Capability requests:**
When the agent wants a new skill:
1. Documents the need in `notes/capabilities.md`
2. Optionally drafts a SKILL.md
3. Human reviews and enables (or agent self-installs if permitted)

---

## Open Questions

- [x] What's the minimal runtime? → **Node.js** (Ink for CLI, same ecosystem as pi-ai)
- [x] How do we handle LLM provider abstraction? → **pi-ai library** (Claude Code OAuth primary)
- [ ] Capability inheritance for skills?
- [ ] Secure secret management (vault integration?)
- [ ] Update mechanism that preserves local modifications?
- [x] How does the agent request new capabilities? → **notes/capabilities.md**

## Non-Goals

- **Not a product** — no onboarding, no hand-holding
- **Not multi-tenant** — one agent per box
- **Not cloud-native** — runs on metal
- **Not foolproof** — you can absolutely break things

---

*This is a living document. The agent maintains it.*
