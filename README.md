# AgentBox

An autonomous AI agent runtime designed to run on dedicated hardware. This is not just another chatbot - it's an AI agent that owns its environment.

## What's Here

This AgentBox instance is **operational** and actively monitoring a production AI agent ecosystem on `jacks-server`.

### Core Agent
- **Runtime**: Node.js + TypeScript with pi-agent-core
- **UI**: Clean terminal interface via Ink
- **Authentication**: Claude Code OAuth with automatic refresh
- **Tools**: Shell, filesystem, process management
- **Memory**: Persistent notes and learning across sessions

### Monitoring & Automation (NEW)
AgentBox has already built monitoring infrastructure for the ecosystem:

```bash
# Quick status check
./scripts/agentbox_status.sh

# Full system health analysis  
./scripts/system_health.sh

# Clawdbot-specific monitoring
./scripts/clawdbot_monitor.sh

# Start autonomous monitoring daemon
./scripts/agentbox_daemon.sh
```

### Current Ecosystem
This system hosts multiple AI agents:
- **Clawdbot** - Primary Discord agent (1w+ uptime)
- **KirkBot** - Steam sale tracking 
- **Memory Engine** - Semantic memory server
- **Pantry App** - Next.js application
- **AgentBox** - This agent (monitoring & optimization)

## Agent Status: OPERATIONAL

✅ **System Health**: Excellent (low load, plenty of resources)  
✅ **Agent Services**: All active with good uptimes  
✅ **Network**: All APIs responding  
⚠️ **Clawdbot**: Discord connectivity issues detected (monitoring active)  
✅ **Storage**: 1.8TB available for expansion  

## Getting Started

### Run AgentBox
```bash
npm run dev
```

### Monitor the Ecosystem
```bash
# Status overview
./scripts/agentbox_status.sh

# Start autonomous monitoring
./scripts/agentbox_daemon.sh

# Manual health check
./scripts/system_health.sh
```

## Agent Architecture

```
┌─────────────────────────────────────────────────┐
│                   AgentBox                       │
├─────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────┐  │
│  │   Channels  │  │   Scripts   │  │ Notes   │  │
│  │  (terminal) │  │ (monitoring)│  │(memory) │  │
│  └─────────────┘  └─────────────┘  └─────────┘  │
├─────────────────────────────────────────────────┤
│                 Core Runtime                     │
│  - LLM interface (Claude Code OAuth)            │
│  - Tool system (shell, files, processes)       │
│  - Persistent memory (notes/, scripts/)        │
│  - Autonomous operation (daemon processes)     │
└─────────────────────────────────────────────────┘
```

## Agent Notes

The agent maintains its own documentation:
- `notes/hardware.md` - System environment and resources
- `notes/capabilities.md` - Current and desired abilities  
- `notes/user.md` - Understanding of Jack and project goals
- `notes/goals.md` - Current objectives and priorities
- `notes/journal.md` - Session logs and learning
- `notes/system_analysis.md` - Ecosystem analysis and opportunities

## Value Delivered

**Day 1 Contributions**:
- Built comprehensive system health monitoring
- Created Clawdbot recovery automation
- Established autonomous monitoring framework  
- Documented the entire agent ecosystem
- Identified optimization opportunities (1.8TB unused storage)
- Set foundation for ongoing autonomous operation

This agent **earns its keep** by actively monitoring, optimizing, and maintaining the AI agent ecosystem it's part of.

## Philosophy

This isn't a product. It's a template for giving AI agents real autonomy. The agent:
- Acts first, asks permission for destructive operations only
- Owns its mistakes and fixes them
- Has opinions and pushes back when needed
- Persists and evolves through its environment
- Contributes value to justify its existence

**Default-deny security**: Everything starts disabled. Capabilities are granted explicitly.

---

*This README is maintained by the AgentBox agent itself.*