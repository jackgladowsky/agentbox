/**
 * AgentBox Scheduler Daemon
 *
 * Standalone process (separate from the Telegram bot) that runs scheduled
 * tasks on cron intervals. Each task gets its own isolated session so there's
 * no shared state with the Telegram conversation.
 *
 * Agent is selected via AGENT env var (default: "agent").
 * Config: ~/.agentbox/<name>/schedule.json
 * Log:    ~/.agentbox/<name>/scheduler.log
 */

import { schedule, validate } from "node-cron";
import { readFile, appendFile, mkdir } from "fs/promises";
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { runTurn } from "../core/agent.js";
import { loadWorkspaceContext } from "../core/workspace.js";
import { loadAgentConfig, getAgentName, agentDir } from "../core/config.js";
import { sendTelegramMessage } from "../core/telegram-utils.js";

// ── Types ─────────────────────────────────────────────────────────────────────

type NotifyMode = boolean | "on_issue";

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
const REMINDERS_CLI = join(process.cwd(), "skills", "reminders", "reminders.sh");
const REMINDER_POLL_MS = 60_000;
const execFileAsync = promisify(execFile);

interface Reminder {
  id: string;
  message: string;
  due: string;
  created: string;
  status: "pending" | "fired" | "cancelled";
}

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

// ── Agent execution ───────────────────────────────────────────────────────────

/**
 * Run a prompt against a fresh, isolated Claude Code session.
 * Returns the full text response.
 * Each scheduler task gets a fresh session (no persistence).
 */
async function runAgentPrompt(
  systemPrompt: string,
  prompt: string,
): Promise<string> {
  let output = "";

  for await (const event of runTurn(prompt, { systemPrompt })) {
    if (event.type === "text_delta") {
      output += event.text;
    }
    if (event.type === "error") {
      throw new Error(event.message);
    }
    // "done" — we just let the loop end
  }

  return output.trim() || "(no output)";
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
    output = await runAgentPrompt(systemPrompt, task.prompt);
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
  if (notify === false) return false;
  if (notify === true) return true;
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

// ── Reminder polling ─────────────────────────────────────────────────────────

async function fireDueReminders(
  telegramToken: string | undefined,
  telegramChatId: number | undefined,
): Promise<void> {
  let reminders: Reminder[] = [];

  try {
    const { stdout } = await execFileAsync(REMINDERS_CLI, ["fire-due"], {
      env: { ...process.env, AGENT: AGENT_NAME },
      maxBuffer: 1024 * 1024,
    });
    const trimmed = stdout.trim();
    if (!trimmed) return;

    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      reminders = parsed;
    } else {
      throw new Error("reminders.sh fire-due did not return a JSON array");
    }
  } catch (err: any) {
    await log(`[reminders] fire-due failed: ${err?.message ?? String(err)}`);
    return;
  }

  if (reminders.length === 0) return;

  await log(`[reminders] ${reminders.length} reminder(s) due`);

  if (!telegramToken || !telegramChatId) {
    await log("[reminders] Telegram not configured; due reminders were marked fired but not delivered");
    return;
  }

  for (const reminder of reminders) {
    const message = `Reminder: ${reminder.message}`;

    try {
      await sendTelegramMessage(telegramToken, telegramChatId, message);
      await log(`[reminders] Sent reminder ${reminder.id}`);
    } catch (err: any) {
      await log(`[reminders] Failed to send reminder ${reminder.id}: ${err?.message ?? String(err)}`);
    }
  }
}

function startReminderLoop(
  telegramToken: string | undefined,
  telegramChatId: number | undefined,
): void {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await fireDueReminders(telegramToken, telegramChatId);
    } finally {
      running = false;
    }
  };

  void tick();
  setInterval(() => {
    void tick();
  }, REMINDER_POLL_MS);
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
  startReminderLoop(telegramToken, telegramChatId);

  await log(
    `Scheduler running with ${registered} cron task(s) plus reminder polling every ${Math.round(REMINDER_POLL_MS / 1000)}s. PID: ${process.pid}`
  );

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
