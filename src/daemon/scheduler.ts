/**
 * Rex Scheduler Daemon
 *
 * Standalone process (separate from the Telegram bot) that runs scheduled
 * tasks on cron intervals. Each task gets its own isolated agent instance
 * so there's no shared state with the Telegram conversation.
 *
 * Config: ~/.agentbox/rex/schedule.json
 * Log:    ~/.agentbox/rex/scheduler.log
 */

import { schedule, validate } from "node-cron";
import { readFile, appendFile, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { createAgent } from "../core/agent.js";
import { loadWorkspaceContext } from "../core/workspace.js";
import { loadAgentConfig, agentDir } from "../core/config.js";
import { type AgentEvent, type AgentMessage } from "@mariozechner/pi-agent-core";
import { type AssistantMessage, type TextContent } from "@mariozechner/pi-ai";

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

const AGENT_NAME = process.env.AGENT ?? "rex";
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

// ── Telegram notifications ────────────────────────────────────────────────────

async function sendTelegram(token: string, chatId: number, text: string): Promise<void> {
  const MAX_LEN = 4096;
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_LEN) {
      chunks.push(remaining);
      break;
    }
    let split = remaining.lastIndexOf("\n", MAX_LEN);
    if (split < MAX_LEN * 0.5) split = MAX_LEN;
    chunks.push(remaining.slice(0, split));
    remaining = remaining.slice(split).trimStart();
  }

  for (const chunk of chunks) {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: chunk }),
      }
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Telegram API error ${res.status}: ${body}`);
    }
  }
}

// ── Agent execution ───────────────────────────────────────────────────────────

/**
 * Run a prompt against a fresh, isolated agent instance.
 * Returns the final assistant text output.
 */
async function runAgentPrompt(
  systemPrompt: string,
  prompt: string,
  taskId: string,
  openrouterKey?: string
): Promise<string> {
  const agent = createAgent(systemPrompt, undefined, openrouterKey);

  return new Promise<string>((resolve, reject) => {
    let finalText = "";

    const isAssistant = (m: AgentMessage): m is AssistantMessage =>
      (m as AssistantMessage).role === "assistant";

    const unsubscribe = agent.subscribe((event: AgentEvent) => {
      if (event.type === "agent_end") {
        unsubscribe();
        const lastMsg = [...event.messages].reverse().find(isAssistant);
        if (lastMsg) {
          finalText = lastMsg.content
            .filter((c): c is TextContent => c.type === "text")
            .map(c => c.text)
            .join("")
            .trim();
        }
        resolve(finalText || "(no output)");
      }
    });

    agent.prompt(prompt).catch((err: Error) => {
      unsubscribe();
      reject(err);
    });
  });
}

// ── Task runner ───────────────────────────────────────────────────────────────

async function runTask(
  task: ScheduledTask,
  systemPrompt: string,
  telegramToken: string | undefined,
  telegramChatId: number | undefined,
  openrouterKey?: string
): Promise<TaskResult> {
  const startedAt = new Date();
  await log(`[${task.id}] Starting: ${task.name}`);

  let output = "";
  let success = true;

  try {
    output = await runAgentPrompt(systemPrompt, task.prompt, task.id, openrouterKey);
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
      await sendTelegram(telegramToken, telegramChatId, message);
      await log(`[${task.id}] Telegram notification sent`);
    } catch (err: any) {
      await log(`[${task.id}] Failed to send Telegram notification: ${err?.message}`);
    }
  }

  return result;
}

/**
 * Resolve whether to send a Telegram notification based on the task's notify setting.
 */
function resolveNotify(notify: NotifyMode, success: boolean, output: string): boolean {
  if (notify === false) return false;
  if (notify === true) return true;
  if (notify === "on_issue") {
    // Notify if the task failed or if the output signals a problem
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

/** Map from task id → active node-cron ScheduledTask handle */
const activeCronJobs = new Map<string, ReturnType<typeof schedule>>();

/**
 * Stop all currently running cron jobs, then register a new set of tasks.
 * Returns the number of successfully registered tasks.
 */
async function registerTasks(
  tasks: ScheduledTask[],
  systemPrompt: string,
  telegramToken: string | undefined,
  telegramChatId: number | undefined
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
      // Each invocation runs independently; errors don't affect other tasks
      try {
        await runTask(task, systemPrompt, telegramToken, telegramChatId);
      } catch (err: any) {
        // Catch any unexpected errors at the top level so the scheduler stays alive
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
  // Ensure log directory exists
  await mkdir(AGENT_DIR, { recursive: true });

  await log(`Scheduler starting for agent: ${AGENT_NAME}`);

  // Load agent config (for Telegram token + allowed users)
  const config = await loadAgentConfig(AGENT_NAME);
  const telegramToken = config.telegram?.token;
  const telegramChatId = config.telegram?.allowedUsers?.[0]; // notify the first allowed user
  const openrouterKey = config.openrouterKey;

  if (!telegramToken || !telegramChatId) {
    await log(
      `Warning: No Telegram config found — notifications disabled. ` +
      `Add telegram.token and telegram.allowedUsers to ~/.agentbox/${AGENT_NAME}/config.json`
    );
  }

  // Build system prompt once and reuse across all tasks
  const { systemPrompt } = await loadWorkspaceContext();

  // Load task schedule and register tasks
  const tasks = await loadSchedule();
  await log(`Loaded ${tasks.length} task(s) from ${SCHEDULE_PATH}`);

  const registered = await registerTasks(tasks, systemPrompt, telegramToken, telegramChatId);

  if (registered === 0) {
    await log("No valid tasks registered — exiting.");
    process.exit(1);
  }

  await log(`Scheduler running with ${registered} task(s). PID: ${process.pid}`);

  // Keep process alive
  process.on("SIGINT", async () => {
    await log("Scheduler stopping (SIGINT)");
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await log("Scheduler stopping (SIGTERM)");
    process.exit(0);
  });

  process.on("SIGHUP", async () => {
    await log("[Scheduler] SIGHUP received — reloading schedule...");
    try {
      const newTasks = await loadSchedule();
      await log(`[Scheduler] Loaded ${newTasks.length} task(s) from ${SCHEDULE_PATH}`);
      const newCount = await registerTasks(newTasks, systemPrompt, telegramToken, telegramChatId);
      await log(`[Scheduler] Reload complete — ${newCount} task(s) active`);
    } catch (err: any) {
      await log(`[Scheduler] Reload failed — keeping old schedule. Error: ${err?.message ?? String(err)}`);
    }
  });

  process.on("uncaughtException", async (err) => {
    await log(`Uncaught exception: ${err.message}\n${err.stack}`);
    // Don't exit — keep the scheduler alive
  });

  process.on("unhandledRejection", async (reason) => {
    await log(`Unhandled rejection: ${String(reason)}`);
  });
}

main().catch(async (err) => {
  console.error("[Scheduler] Fatal startup error:", err);
  try {
    await appendFile(LOG_PATH, `[${new Date().toISOString()}] FATAL: ${err}\n`);
  } catch {}
  process.exit(1);
});
