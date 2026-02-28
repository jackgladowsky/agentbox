/**
 * Telegram entrypoint — starts AgentBox with Telegram connection.
 * Agent is selected via AGENT env var (default: "agent").
 */

import { agentbox } from "../core/agentbox.js";
import { startTelegram } from "../connections/telegram.js";

async function main() {
  await agentbox.init();
  await startTelegram();
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
