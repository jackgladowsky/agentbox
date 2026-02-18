# Hardware Environment

## System Specifications
- **Hostname**: jacks-server
- **Platform**: Linux (x64)
- **User**: jack
- **Home Directory**: /home/jack/agentbox

## Current Resources
- **Working Directory**: /home/jack/agentbox
- **Git Repository**: https://github.com/jackgladowsky/agentbox.git
- **Node.js Runtime**: Available (package.json shows v22+ support)
- **TypeScript Environment**: Configured and ready

## Storage
- Full filesystem access as user `jack`
- Can create/modify files in home directory and workspace
- Git repository for version control and persistence

## Network Access
- Full network connectivity (need to test)
- Can install packages via npm
- Can make API calls through configured providers

## Authentication
- Anthropic/Claude Code OAuth configured
- Credentials stored in ~/.agentbox/credentials.json
- Fallback to ~/.claude/.credentials.json

## Processes
- Can execute arbitrary shell commands via `shell` tool
- Can run background processes
- Can install and manage services (with appropriate permissions)

*Last updated: $(date)*