#!/usr/bin/env node
/**
 * agentbox-deploy — Rebuild and restart a running agent.
 *
 * Usage:
 *   AGENT=myagent npm run deploy          — rebuild + restart services
 *   AGENT=myagent npm run deploy status   — show service status
 *   AGENT=myagent npm run deploy stop     — stop and disable services
 *
 * For first-time setup, use `npm run create` instead.
 */

import { access } from "fs/promises";
import { join, resolve, dirname } from "path";
import { homedir } from "os";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const AGENTBOX_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function agentName(): string {
  const name = process.env.AGENT || "agent";
  if (!/^[a-z0-9_-]+$/i.test(name)) {
    console.error(`Invalid agent name: "${name}"`);
    process.exit(1);
  }
  return name;
}

function run(cmd: string): void {
  try {
    execSync(cmd, { stdio: "inherit", cwd: AGENTBOX_ROOT });
  } catch {
    process.exit(1);
  }
}

// ── Commands ─────────────────────────────────────────────────────────────────

async function deploy(name: string) {
  const botUnit = `agentbox-${name}.service`;
  const schedUnit = `agentbox-${name}-scheduler.service`;

  // Verify agent exists
  try {
    await access(join(homedir(), ".agentbox", name, "config.json"));
  } catch {
    console.error(`Agent "${name}" not found. Run: npm run create`);
    process.exit(1);
  }

  console.log(`\n⚙️  Rebuilding ${name}...`);
  run("npm run build");

  console.log("\n🚀 Restarting services...");
  run(`systemctl --user daemon-reload`);
  run(`systemctl --user restart ${botUnit} ${schedUnit}`);

  console.log("\n✅ Deployed!\n");
  run(`systemctl --user status ${botUnit} ${schedUnit} --no-pager -l`);
  console.log();
}

function stop(name: string) {
  const botUnit = `agentbox-${name}.service`;
  const schedUnit = `agentbox-${name}-scheduler.service`;

  console.log(`\n🛑 Stopping ${name}...`);
  run(`systemctl --user stop ${botUnit} ${schedUnit}`);
  run(`systemctl --user disable ${botUnit} ${schedUnit}`);
  console.log("Done.\n");
}

function status(name: string) {
  const botUnit = `agentbox-${name}.service`;
  const schedUnit = `agentbox-${name}-scheduler.service`;
  console.log();
  run(`systemctl --user status ${botUnit} ${schedUnit} --no-pager -l`);
  console.log();
}

// ── Main ─────────────────────────────────────────────────────────────────────

const name = agentName();
const command = process.argv[2] ?? "deploy";

switch (command) {
  case "deploy":  await deploy(name); break;
  case "stop":    stop(name); break;
  case "status":  status(name); break;
  default:
    console.error(`Unknown command: ${command}`);
    console.error("Usage: AGENT=<name> npm run deploy [deploy|stop|status]");
    process.exit(1);
}
