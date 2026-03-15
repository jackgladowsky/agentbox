/**
 * AgentBox Scheduler Daemon
 *
 * Standalone process (separate from the Telegram bot) that runs scheduled
 * tasks on cron intervals. Each task maintains its own persistent session
 * so the agent retains context across runs (no shared state with the
 * Telegram conversation). Sessions are stored per task ID in
 * ~/.agentbox/<name>/sessions/.
 *
 * Agent is selected via AGENT env var (default: "agent").
 * Config: ~/.agentbox/<name>/schedule.json
 * Log:    ~/.agentbox/<name>/scheduler.log
 */

import { schedule, validate } from "node-cron";
import { readFile, writeFile, appendFile, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { runTurn } from "../core/agent.js";
import { loadWorkspaceContext } from "../core/workspace.js";
import { loadAgentConfig, getAgentName, agentDir } from "../core/config.js";
import { sendTelegramMessage } from "../core/telegram-utils.js";

// ── Types ─────────────────────────────────────────────────────────────────────

type NotifyMode = boolean | "on_issue" | "always" | "never";

interface ScheduledTask {
  id: string;
  name: string;
  schedule: string;
  prompt: string;
  /** true = always notify, false = never, "on_issue" = notify only when result contains a problem */
  notify: NotifyMode;
}

interface ScheduleFile {
  tasks: ScheduledTask[];
}

interface TaskResult {
  taskId: string;
  taskName: string;
  success: boolean;
  output: string;
  startedAt: Date;
  finishedAt: Date;
}

// ── Paths ─────────────────────────────────────────────────────────────────────

const AGENT_NAME = getAgentName();
const AGENT_DIR = agentDir(AGENT_NAME);
const SCHEDULE_PATH = join(AGENT_DIR, "schedule.json");
const LOG_PATH = join(AGENT_DIR, "scheduler.log");

// ── Logging ───────────────────────────────────────────────────────────────────

async function log(message: string): Promise<void> {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${message}\n`;
  process.stdout.write(line);
  try {
    await appendFile(LOG_PATH, line, "utf-8");
  } catch {
    // If we can't write the log, at least stdout got it
  }
}

// ── Per-task session persistence ──────────────────────────────────────────────

function taskSessionPath(taskId: string): string {
  return join(AGENT_DIR, "sessions", `${taskId}.session`);
}

async function loadTaskSessionId(taskId: string): Promise<string | undefined> {
  try {
    const id = await readFile(taskSessionPath(taskId), "utf-8");
    return id.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function saveTaskSessionId(taskId: string, sessionId: string): Promise<void> {
  const path = taskSessionPath(taskId);
  await mkdir(join(AGENT_DIR, "sessions"), { recursive: true });
  await writeFile(path, sessionId, "utf-8");
}

// ── Agent execution ───────────────────────────────────────────────────────────

/**
 * Run a prompt against a Claude Code session, resuming from a previous
 * session if available. Returns the text response and the session ID
 * so the caller can persist it for next run.
 */
async function runAgentPrompt(
  systemPrompt: string,
  prompt: string,
  sessionId?: string,
): Promise<{ output: string; sessionId: string }> {
  let output = "";
  let resolvedSessionId = "";

  for await (const event of runTurn(prompt, { systemPrompt, sessionId })) {
    if (event.type === "text_delta") {
      output += event.text;
    }
    if (event.type === "error") {
      throw new Error(event.message);
    }
    if (event.type === "done") {
      resolvedSessionId = event.sessionId;
    }
  }

  return { output: output.trim() || "(no output)", sessionId: resolvedSessionId };
}

// ── Task prompt builder ───────────────────────────────────────────────────────

function buildTaskPrompt(task: ScheduledTask): string {
  return [
    `You are running as a scheduled task. Your output will be sent as a Telegram notification, so be concise and focus on what's actionable. Compare against previous runs when relevant.`,
    ``,
    `Task: ${task.name} (${task.id})`,
    ``,
    task.prompt,
  ].join("\n");
}

// ── Task runner ───────────────────────────────────────────────────────────────

async function runTask(
  task: ScheduledTask,
  systemPrompt: string,
  telegramToken: string | undefined,
  telegramChatId: number | undefined,
): Promise<TaskResult> {
  const startedAt = new Date();
  await log(`[${task.id}] Starting: ${task.name}`);

  let output = "";
  let success = true;

  try {
    const previousSessionId = await loadTaskSessionId(task.id);
    if (previousSessionId) {
      await log(`[${task.id}] Resuming session ${previousSessionId.slice(0, 8)}...`);
    }

    const taskPrompt = buildTaskPrompt(task);

    const result = await runAgentPrompt(systemPrompt, taskPrompt, previousSessionId);
    output = result.output;

    if (result.sessionId) {
      await saveTaskSessionId(task.id, result.sessionId);
    }

    await log(`[${task.id}] Completed. Output length: ${output.length} chars`);
  } catch (err: any) {
    success = false;
    output = `Task failed: ${err?.message ?? String(err)}`;
    await log(`[${task.id}] ERROR: ${output}`);
  }

  const finishedAt = new Date();
  const result: TaskResult = { taskId: task.id, taskName: task.name, success, output, startedAt, finishedAt };

  // Decide whether to notify
  const shouldNotify = resolveNotify(task.notify, success, output);

  if (shouldNotify && telegramToken && telegramChatId) {
    const durationSec = Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000);
    const header = success
      ? `[Scheduler] ${task.name}`
      : `[Scheduler] ${task.name} — FAILED`;
    const message = `${header}\n\n${output}\n\n_(${durationSec}s)_`;

    try {
      await sendTelegramMessage(telegramToken, telegramChatId, message);
      await log(`[${task.id}] Telegram notification sent`);
    } catch (err: any) {
      await log(`[${task.id}] Failed to send Telegram notification: ${err?.message}`);
    }
  }

  return result;
}

/**
 * Resolve whether to send a Telegram notification.
 */
function resolveNotify(notify: NotifyMode, success: boolean, output: string): boolean {
  if (notify === false || notify === "never") return false;
  if (notify === true || notify === "always") return true;
  if (notify === "on_issue") {
    if (!success) return true;
    const lower = output.toLowerCase();
    return (
      lower.includes("warning") ||
      lower.includes("error") ||
      lower.includes("critical") ||
      lower.includes("down") ||
      lower.includes("fail") ||
      lower.includes("issue") ||
      lower.includes("alert")
    );
  }
  return false;
}

// ── Schedule loading ──────────────────────────────────────────────────────────

async function loadSchedule(): Promise<ScheduledTask[]> {
  const raw = await readFile(SCHEDULE_PATH, "utf-8");
  const parsed: ScheduleFile = JSON.parse(raw);
  if (!Array.isArray(parsed.tasks)) {
    throw new Error(`schedule.json must have a "tasks" array`);
  }
  return parsed.tasks;
}

// ── Task registration ─────────────────────────────────────────────────────────

const activeCronJobs = new Map<string, ReturnType<typeof schedule>>();

async function registerTasks(
  tasks: ScheduledTask[],
  systemPrompt: string,
  telegramToken: string | undefined,
  telegramChatId: number | undefined,
): Promise<number> {
  // Stop and clear existing cron jobs
  for (const [id, job] of activeCronJobs) {
    job.stop();
    activeCronJobs.delete(id);
  }

  let count = 0;

  for (const task of tasks) {
    if (!validate(task.schedule)) {
      await log(`[${task.id}] Invalid cron expression "${task.schedule}" — skipping`);
      continue;
    }

    await log(`[${task.id}] Registered: "${task.name}" @ ${task.schedule}`);

    const job = schedule(task.schedule, async () => {
      try {
        await runTask(task, systemPrompt, telegramToken, telegramChatId);
      } catch (err: any) {
        await log(`[${task.id}] Unexpected top-level error: ${err?.message ?? String(err)}`);
      }
    });

    activeCronJobs.set(task.id, job);
    count++;
  }

  return count;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await mkdir(AGENT_DIR, { recursive: true });

  await log(`Scheduler starting for agent: ${AGENT_NAME}`);

  const config = await loadAgentConfig(AGENT_NAME);
  const telegramToken = config.telegram?.token;
  const telegramChatId = config.telegram?.allowedUsers?.[0];

  if (!telegramToken || !telegramChatId) {
    await log(
      `Warning: No Telegram config found — notifications disabled. ` +
      `Add telegram.token and telegram.allowedUsers to ~/.agentbox/${AGENT_NAME}/config.json`
    );
  }

  const { systemPrompt } = await loadWorkspaceContext();

  const tasks = await loadSchedule();
  await log(`Loaded ${tasks.length} task(s) from ${SCHEDULE_PATH}`);

  const registered = await registerTasks(tasks, systemPrompt, telegramToken, telegramChatId);

  if (registered === 0) {
    await log("No valid tasks registered — exiting.");
    process.exit(1);
  }

  await log(`Scheduler running with ${registered} task(s). PID: ${process.pid}`);

  process.on("SIGINT", async () => { await log("Scheduler stopping (SIGINT)"); process.exit(0); });
  process.on("SIGTERM", async () => { await log("Scheduler stopping (SIGTERM)"); process.exit(0); });

  process.on("SIGHUP", async () => {
    await log("[Scheduler] SIGHUP received — reloading schedule...");
    try {
      const newTasks = await loadSchedule();
      const newCount = await registerTasks(newTasks, systemPrompt, telegramToken, telegramChatId);
      await log(`[Scheduler] Reload complete — ${newCount} task(s) active`);
    } catch (err: any) {
      await log(`[Scheduler] Reload failed — keeping old schedule. Error: ${err?.message ?? String(err)}`);
    }
  });

  process.on("uncaughtException", async (err) => {
    await log(`Uncaught exception: ${err.message}\n${err.stack}`);
  });

  process.on("unhandledRejection", async (reason) => {
    await log(`Unhandled rejection: ${String(reason)}`);
  });
}

main().catch(async (err) => {
  console.error("[Scheduler] Fatal startup error:", err);
  try { await appendFile(LOG_PATH, `[${new Date().toISOString()}] FATAL: ${err}\n`); } catch {}
  process.exit(1);
});
