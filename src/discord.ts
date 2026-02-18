/**
 * Discord entrypoint — starts Rex + Discord connection.
 */

import { rex } from "./rex.js";
import { startDiscord } from "./connections/discord.js";

async function main() {
  await rex.init();
  await startDiscord();
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
