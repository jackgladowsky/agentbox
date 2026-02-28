/**
 * TUI entrypoint — starts AgentBox with terminal interface.
 * Agent is selected via AGENT env var (default: "agent").
 */

import { agentbox } from "../core/agentbox.js";
import { hasCredentials } from "../core/auth.js";
import { startTUI } from "../connections/tui.js";

async function main() {
  const hasAuth = await hasCredentials();
  if (!hasAuth) {
    console.error(
      "No Claude Code credentials found.\n" +
      "Run `claude` to authenticate, then restart."
    );
    process.exit(1);
  }

  await agentbox.init();
  await startTUI();
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
