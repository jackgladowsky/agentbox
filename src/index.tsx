/**
 * TUI entrypoint — starts Rex + terminal interface.
 */

import { rex } from "./rex.js";
import { hasCredentials, login } from "./auth.js";
import { startTUI } from "./connections/tui.js";

async function main() {
  const hasAuth = await hasCredentials("anthropic");
  if (!hasAuth) {
    console.log("No Anthropic credentials found.");
    const success = await login("anthropic");
    if (!success) {
      console.error("Could not authenticate. Run 'claude' first.");
      process.exit(1);
    }
  }

  await rex.init();
  await startTUI();
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
