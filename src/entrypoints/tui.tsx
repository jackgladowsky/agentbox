/**
 * TUI entrypoint — starts AgentBox with terminal interface.
 * Agent is selected via AGENT env var (default: "agent").
 */

import { agentbox } from "../core/agentbox.js";
import { startTUI } from "../connections/tui.js";

async function main() {
  await agentbox.init();
  await startTUI();
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
