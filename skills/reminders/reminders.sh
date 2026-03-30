#!/usr/bin/env bash
set -euo pipefail

node --input-type=module - "$@" <<'NODE'
import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { homedir } from "os";

const args = process.argv.slice(2);
const command = args[0];
const agentName = process.env.AGENT || "agent";
const remindersPath = join(homedir(), ".agentbox", agentName, "reminders.json");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function usage() {
  fail(
    "Usage:\n" +
    "  reminders.sh add --message \"...\" --due \"ISO8601\"\n" +
    "  reminders.sh list [--status pending]\n" +
    "  reminders.sh cancel <id>\n" +
    "  reminders.sh fire-due"
  );
}

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      fail(`Unexpected argument: ${arg}`);
    }
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      fail(`Missing value for --${key}`);
    }
    flags[key] = value;
    i++;
  }
  return flags;
}

function parseIso(input) {
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) {
    fail(`Invalid datetime: ${input}`);
  }
  return date.toISOString();
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

async function ensureStore() {
  await mkdir(dirname(remindersPath), { recursive: true });

  try {
    const raw = await readFile(remindersPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error("reminders.json must contain a JSON array");
    }
    return parsed;
  } catch (err) {
    if (err && err.code === "ENOENT") {
      await writeJson([]);
      return [];
    }
    if (err instanceof SyntaxError) {
      fail(`Invalid JSON in ${remindersPath}`);
    }
    if (err?.message === "reminders.json must contain a JSON array") {
      fail(err.message);
    }
    throw err;
  }
}

async function writeJson(data) {
  const tmpPath = `${remindersPath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  await rename(tmpPath, remindersPath);
}

function formatReminder(reminder) {
  return [
    `${reminder.id} [${reminder.status}]`,
    `  due: ${reminder.due}`,
    `  msg: ${reminder.message}`,
  ].join("\n");
}

async function addReminder(argv) {
  const flags = parseFlags(argv);
  if (!flags.message || !flags.due) usage();

  const reminders = await ensureStore();
  const reminder = {
    id: makeId("rem"),
    message: flags.message.trim(),
    due: parseIso(flags.due),
    created: new Date().toISOString(),
    status: "pending",
  };

  if (!reminder.message) {
    fail("Reminder message cannot be empty");
  }

  reminders.push(reminder);
  await writeJson(reminders);
  process.stdout.write(JSON.stringify(reminder, null, 2) + "\n");
}

async function listReminders(argv) {
  const flags = parseFlags(argv);
  const reminders = await ensureStore();
  let filtered = reminders;

  if (flags.status) {
    filtered = filtered.filter(reminder => reminder.status === flags.status);
  }

  filtered.sort((a, b) => {
    const aTime = new Date(a.due).getTime();
    const bTime = new Date(b.due).getTime();
    return aTime - bTime;
  });

  if (filtered.length === 0) {
    process.stdout.write("No reminders.\n");
    return;
  }

  process.stdout.write(filtered.map(formatReminder).join("\n\n") + "\n");
}

async function cancelReminder(id) {
  if (!id) usage();

  const reminders = await ensureStore();
  const reminder = reminders.find(entry => entry.id === id);
  if (!reminder) {
    fail(`Reminder not found: ${id}`);
  }

  if (reminder.status !== "pending") {
    fail(`Reminder ${id} is already ${reminder.status}`);
  }

  reminder.status = "cancelled";
  await writeJson(reminders);
  process.stdout.write(JSON.stringify(reminder, null, 2) + "\n");
}

async function fireDue() {
  const reminders = await ensureStore();
  const now = Date.now();
  const due = reminders
    .filter(reminder => reminder.status === "pending" && new Date(reminder.due).getTime() <= now)
    .sort((a, b) => new Date(a.due).getTime() - new Date(b.due).getTime());

  if (due.length === 0) {
    process.stdout.write("[]\n");
    return;
  }

  for (const reminder of due) {
    reminder.status = "fired";
  }

  await writeJson(reminders);
  process.stdout.write(JSON.stringify(due, null, 2) + "\n");
}

switch (command) {
  case "add":
    await addReminder(args.slice(1));
    break;
  case "list":
    await listReminders(args.slice(1));
    break;
  case "cancel":
    await cancelReminder(args[1]);
    break;
  case "fire-due":
    await fireDue();
    break;
  default:
    usage();
}
NODE
