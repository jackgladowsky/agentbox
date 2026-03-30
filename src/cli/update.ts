#!/usr/bin/env node
/**
 * agentbox-update — Pull latest code and redeploy a running agent.
 *
 * Usage:
 *   AGENT=myagent npm run update
 *   npm run update -- myagent
 *   agentbox-update myagent
 */

import { access, readFile } from "fs/promises";
import { createHash } from "crypto";
import { execSync } from "child_process";
import { join, resolve, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

const AGENTBOX_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function printUsage(): void {
  console.log(
    "Usage:\n" +
    "  AGENT=<name> npm run update\n" +
    "  npm run update -- <name>\n" +
    "  agentbox-update <name>"
  );
}

function agentName(): string {
  const argName = process.argv[2];
  const name = argName || process.env.AGENT || "agent";
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

function capture(cmd: string): string {
  try {
    return execSync(cmd, {
      cwd: AGENTBOX_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    }).trim();
  } catch (err: any) {
    const message = err?.stderr?.toString?.().trim() || err?.message || String(err);
    console.error(message);
    process.exit(1);
  }
}

async function fileHash(path: string): Promise<string | null> {
  try {
    const data = await readFile(path);
    return createHash("sha256").update(data).digest("hex");
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

async function verifyAgentExists(name: string): Promise<void> {
  try {
    await access(join(homedir(), ".agentbox", name, "config.json"));
  } catch {
    console.error(`Agent "${name}" not found. Run: npm run create -- ${name}`);
    process.exit(1);
  }
}

function ensureCleanWorktree(): void {
  const status = capture("git status --porcelain");
  if (!status) return;

  console.error("Refusing to update: git worktree is not clean.");
  console.error("Commit, stash, or discard local changes first.");
  process.exit(1);
}

async function update(name: string): Promise<void> {
  const botUnit = `agentbox-${name}.service`;
  const schedUnit = `agentbox-${name}-scheduler.service`;
  const lockfilePath = join(AGENTBOX_ROOT, "package-lock.json");

  await verifyAgentExists(name);
  ensureCleanWorktree();

  const beforeRev = capture("git rev-parse HEAD");
  const beforeLockHash = await fileHash(lockfilePath);

  console.log("\n⬇️  Pulling latest changes...");
  run("git pull --ff-only");

  const afterRev = capture("git rev-parse HEAD");
  const afterLockHash = await fileHash(lockfilePath);

  if (afterRev === beforeRev) {
    console.log("\nAlready up to date.\n");
    return;
  }

  if (beforeLockHash !== afterLockHash) {
    console.log("\n📦 Installing dependencies...");
    run("npm install");
  } else {
    console.log("\n📦 Dependencies unchanged — skipping npm install.");
  }

  console.log(`\n⚙️  Rebuilding ${name}...`);
  run("npm run build");

  console.log("\n🚀 Restarting services...");
  run("systemctl --user daemon-reload");
  run(`systemctl --user restart ${botUnit} ${schedUnit}`);

  console.log("\n✅ Updated and redeployed.\n");
  run(`systemctl --user status ${botUnit} ${schedUnit} --no-pager -l`);
  console.log();
}

const firstArg = process.argv[2];
if (firstArg === "--help" || firstArg === "-h") {
  printUsage();
  process.exit(0);
}

await update(agentName());
