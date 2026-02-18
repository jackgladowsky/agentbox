/**
 * Telegram entrypoint — starts Rex + Telegram connection.
 */

import { rex } from "./rex.js";
import { hasCredentials, login } from "./auth.js";
import { startTelegram } from "./connections/telegram.js";

async function main() {
  const hasAuth = await hasCredentials("anthropic");
  if (!hasAuth) {
    console.log("No Anthropic credentials found.");
    const ok = await login("anthropic");
    if (!ok) { console.error("Auth failed."); process.exit(1); }
  }

  await rex.init();
  await startTelegram();
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
