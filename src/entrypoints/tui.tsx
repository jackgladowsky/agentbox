/**
 * TUI entrypoint — starts AgentBox with terminal interface.
 * Agent is selected via AGENT env var (default: "agent").
 */

import { agentbox } from "../core/agentbox.js";
import { hasCredentials, login } from "../core/auth.js";
import { startTUI } from "../connections/tui.js";

async function main() {
  const hasAuth = await hasCredentials("anthropic");
  if (!hasAuth) {
    console.log("No Anthropic credentials found.");
    const ok = await login("anthropic");
    if (!ok) { console.error("Auth failed."); process.exit(1); }
  }

  await agentbox.init();
  await startTUI();
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
