#!/usr/bin/env bash
set -euo pipefail

node --input-type=module - "$@" <<'NODE'
import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { homedir } from "os";

const args = process.argv.slice(2);
const command = args[0];
const agentName = process.env.AGENT || "agent";
const tasksPath = join(homedir(), ".agentbox", agentName, "tasks.json");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function usage() {
  fail(
    "Usage:\n" +
    "  tasks.sh add --title \"...\" [--due \"ISO8601\"] [--tags \"school,gym\"]\n" +
    "  tasks.sh list [--status todo] [--tag school]\n" +
    "  tasks.sh done <id>\n" +
    "  tasks.sh remove <id>"
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

function parseOptionalIso(input) {
  if (!input) return null;
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) {
    fail(`Invalid datetime: ${input}`);
  }
  return date.toISOString();
}

function parseTags(raw) {
  if (!raw) return [];
  return [...new Set(raw
    .split(",")
    .map(tag => tag.trim())
    .filter(Boolean))];
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

async function ensureStore() {
  await mkdir(dirname(tasksPath), { recursive: true });

  try {
    const raw = await readFile(tasksPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error("tasks.json must contain a JSON array");
    }
    return parsed;
  } catch (err) {
    if (err && err.code === "ENOENT") {
      await writeJson([]);
      return [];
    }
    if (err instanceof SyntaxError) {
      fail(`Invalid JSON in ${tasksPath}`);
    }
    if (err?.message === "tasks.json must contain a JSON array") {
      fail(err.message);
    }
    throw err;
  }
}

async function writeJson(data) {
  const tmpPath = `${tasksPath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  await rename(tmpPath, tasksPath);
}

function formatTask(task) {
  const lines = [`${task.id} [${task.status}] ${task.title}`];
  if (task.due) lines.push(`  due: ${task.due}`);
  if (task.tags?.length) lines.push(`  tags: ${task.tags.join(", ")}`);
  return lines.join("\n");
}

async function addTask(argv) {
  const flags = parseFlags(argv);
  if (!flags.title) usage();

  const tasks = await ensureStore();
  const task = {
    id: makeId("task"),
    title: flags.title.trim(),
    status: "todo",
    created: new Date().toISOString(),
    completed: null,
    due: parseOptionalIso(flags.due),
    tags: parseTags(flags.tags),
  };

  if (!task.title) {
    fail("Task title cannot be empty");
  }

  tasks.push(task);
  await writeJson(tasks);
  process.stdout.write(JSON.stringify(task, null, 2) + "\n");
}

async function listTasks(argv) {
  const flags = parseFlags(argv);
  const tasks = await ensureStore();
  let filtered = tasks;

  if (flags.status) {
    filtered = filtered.filter(task => task.status === flags.status);
  }

  if (flags.tag) {
    filtered = filtered.filter(task => Array.isArray(task.tags) && task.tags.includes(flags.tag));
  }

  filtered.sort((a, b) => {
    if (a.status !== b.status) return a.status.localeCompare(b.status);
    if (a.due && b.due) return new Date(a.due).getTime() - new Date(b.due).getTime();
    if (a.due) return -1;
    if (b.due) return 1;
    return new Date(a.created).getTime() - new Date(b.created).getTime();
  });

  if (filtered.length === 0) {
    process.stdout.write("No tasks.\n");
    return;
  }

  process.stdout.write(filtered.map(formatTask).join("\n\n") + "\n");
}

async function markDone(id) {
  if (!id) usage();

  const tasks = await ensureStore();
  const task = tasks.find(entry => entry.id === id);
  if (!task) {
    fail(`Task not found: ${id}`);
  }

  if (task.status === "done") {
    fail(`Task ${id} is already done`);
  }

  task.status = "done";
  task.completed = new Date().toISOString();
  await writeJson(tasks);
  process.stdout.write(JSON.stringify(task, null, 2) + "\n");
}

async function removeTask(id) {
  if (!id) usage();

  const tasks = await ensureStore();
  const index = tasks.findIndex(entry => entry.id === id);
  if (index === -1) {
    fail(`Task not found: ${id}`);
  }

  const [removed] = tasks.splice(index, 1);
  await writeJson(tasks);
  process.stdout.write(JSON.stringify(removed, null, 2) + "\n");
}

switch (command) {
  case "add":
    await addTask(args.slice(1));
    break;
  case "list":
    await listTasks(args.slice(1));
    break;
  case "done":
    await markDone(args[1]);
    break;
  case "remove":
    await removeTask(args[1]);
    break;
  default:
    usage();
}
NODE
