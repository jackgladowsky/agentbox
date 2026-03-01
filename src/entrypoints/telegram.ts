/**
 * Telegram entrypoint — starts AgentBox with Telegram connection.
 * Agent is selected via AGENT env var (default: "agent").
 */

import { agentbox } from "../core/agentbox.js";
import { startTelegram } from "../connections/telegram.js";
import { hasCredentials } from "../core/auth.js";

async function main() {
  if (!(await hasCredentials())) {
    console.error(
      "Fatal: No Claude Code credentials found.\n" +
      "Run `claude` once to authenticate, then restart the agent."
    );
    process.exit(1);
  }

  await agentbox.init();
  await startTelegram();
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
