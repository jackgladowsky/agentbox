/**
 * Telegram connection for AgentBox.
 *
 * Uses grammY (https://grammy.dev) — modern, TypeScript-first Telegram bot framework.
 * Supports text, files, images, voice. Auth via allowedUsers whitelist in agent config.
 *
 * Features:
 * - Streaming responses with live message edits (feels like typing)
 * - File/image/voice downloads from Telegram → agent (saves to /tmp)
 * - /help, /clear, /status, /stop commands
 */

import { Bot, Context } from "grammy";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import { agentbox, type MessageSource, type AgentEvent } from "../core/agentbox.js";
import { loadAgentConfig, getAgentName } from "../core/config.js";

// ── Config ────────────────────────────────────────────────────────────────────

const TELEGRAM_MAX_LENGTH = 4096;

function splitMessage(text: string, maxLen = TELEGRAM_MAX_LENGTH): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    let chunk = remaining.slice(0, maxLen);
    const lastNewline = chunk.lastIndexOf("\n");
    if (lastNewline > maxLen * 0.5) chunk = remaining.slice(0, lastNewline);
    chunks.push(chunk);
    remaining = remaining.slice(chunk.length).trimStart();
  }
  return chunks;
}

function sourceId(ctx: Context): string {
  return `telegram:${ctx.chat?.id ?? "unknown"}`;
}

async function downloadFile(bot: Bot, fileId: string, filename: string): Promise<string> {
  const file = await bot.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${(bot as any).token}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download file: ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const dir = join(tmpdir(), "agentbox-uploads");
  await mkdir(dir, { recursive: true });
  const localPath = join(dir, filename);
  await writeFile(localPath, buf);
  return localPath;
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

/** chatIds currently being processed — drop duplicate rapid messages. */
const processingChats = new Set<number>();

// ── Main ──────────────────────────────────────────────────────────────────────

export async function startTelegram(): Promise<void> {
  const agentName = getAgentName();
  const config = await loadAgentConfig(agentName);

  if (!config.telegram?.token) {
    throw new Error(
      `No Telegram config found for agent "${agentName}".\n` +
      `Add a "telegram" block to ~/.agentbox/${agentName}/config.json:\n` +
      `  {\n` +
      `    "name": "${agentName}",\n` +
      `    "telegram": {\n` +
      `      "token": "YOUR_BOT_TOKEN",\n` +
      `      "allowedUsers": [YOUR_TELEGRAM_USER_ID]\n` +
      `    }\n` +
      `  }`
    );
  }

  const { token, allowedUsers } = config.telegram;
  const bot = new Bot(token);
  const allowed = new Set(allowedUsers);
  const displayName = config.name ?? agentName;

  // Auth middleware
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId || !allowed.has(userId)) {
      console.log(`[Telegram] Blocked user ${userId}`);
      return;
    }
    await next();
  });

  // ── Commands ──────────────────────────────────────────────────────────────

  const HELP_TEXT =
    `*${displayName}*\n\n` +
    `  /help    — show this message\n` +
    `  /clear   — clear conversation history\n` +
    `  /status  — model, session & commit info\n` +
    `  /stop    — cancel the current response\n\n` +
    `_Send text, images, files, or voice._`;

  bot.command("start", async (ctx) => {
    await ctx.reply(HELP_TEXT, { parse_mode: "Markdown" });
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(HELP_TEXT, { parse_mode: "Markdown" });
  });

  bot.command("clear", async (ctx) => {
    agentbox.clearMessages();
    await ctx.reply("✓ History cleared");
  });

  bot.command("status", async (ctx) => {
    let commit = "unknown";
    try {
      commit = execSync("git rev-parse --short HEAD", { cwd: process.cwd() }).toString().trim();
    } catch { /* ignore */ }

    const session = agentbox.sessionId?.slice(0, 8) ?? "none";
    const lines = [
      `*${displayName}*`,
      ``,
      `Model    \`${agentbox.modelId ?? "default"}\``,
      `Session  \`${session}\``,
      `Commit   \`${commit}\``,
    ];
    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
  });

  bot.command("stop", async (ctx) => {
    agentbox.abort();
    await ctx.reply("✓ Stopped");
  });

  // ── Message handler ───────────────────────────────────────────────────────

  async function handleMessage(ctx: Context, content: string) {
    const chatId = ctx.chat!.id;

    if (processingChats.has(chatId)) {
      await ctx.reply("Already processing your previous message, please wait.");
      return;
    }

    processingChats.add(chatId);

    const source: MessageSource = {
      id: sourceId(ctx),
      label: `Telegram from ${ctx.from?.username ?? ctx.from?.id}`,
    };

    console.log(`[Telegram] ${ctx.from?.username}: ${content.slice(0, 80)}`);

    const sentMsg = await ctx.reply("…");
    let accumulatedText = "";
    let lastEditedText = "";
    let editTimeout: NodeJS.Timeout | null = null;

    // Debounced edit — sends Telegram edit at most once per second
    const scheduleEdit = () => {
      if (editTimeout) return; // already pending
      editTimeout = setTimeout(async () => {
        editTimeout = null;
        const truncated = accumulatedText.length > TELEGRAM_MAX_LENGTH
          ? accumulatedText.slice(0, TELEGRAM_MAX_LENGTH - 3) + "…"
          : accumulatedText;
        if (truncated !== lastEditedText && truncated.trim()) {
          try {
            await ctx.api.editMessageText(chatId, sentMsg.message_id, truncated);
            lastEditedText = truncated;
          } catch { /* message unchanged or deleted */ }
        }
      }, 1000);
    };

    const unsubscribe = agentbox.subscribe(`telegram-reply:${sourceId(ctx)}`, (event: AgentEvent, evtSource: MessageSource) => {
      if (evtSource.id !== source.id) return;

      if (event.type === "text_delta") {
        accumulatedText += event.text;
        scheduleEdit();
      }

      if (event.type === "done" || event.type === "error") {
        unsubscribe();
        processingChats.delete(chatId);
        if (editTimeout) { clearTimeout(editTimeout); editTimeout = null; }

        // Handle async Telegram API calls in a self-contained promise
        (async () => {
          if (event.type === "done") {
            const finalText = accumulatedText.trim() || "_(no response)_";
            if (finalText.length <= TELEGRAM_MAX_LENGTH) {
              await ctx.api.editMessageText(chatId, sentMsg.message_id, finalText);
            } else {
              try { await ctx.api.deleteMessage(chatId, sentMsg.message_id); } catch {}
              for (const chunk of splitMessage(finalText)) await ctx.reply(chunk);
            }
          } else {
            await ctx.api.editMessageText(
              chatId, sentMsg.message_id,
              `⚠️ Error: ${event.message.slice(0, 500)}`
            );
          }
        })().catch((err) => {
          console.error("[Telegram] Failed to send response:", err);
        });
      }
    });

    agentbox.prompt(content, source).catch(async (err) => {
      unsubscribe();
      processingChats.delete(chatId);
      if (editTimeout) { clearTimeout(editTimeout); editTimeout = null; }
      console.error("[Telegram] Agent error:", err);
      try {
        await ctx.api.editMessageText(
          chatId, sentMsg.message_id,
          `⚠️ Error: ${String(err).slice(0, 500)}`
        );
      } catch {}
    });
  }

  bot.on("message:text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) return;
    await handleMessage(ctx, ctx.message.text);
  });

  bot.on("message:photo", async (ctx) => {
    const photo = ctx.message.photo.at(-1)!;
    const caption = ctx.message.caption ?? "";
    try {
      const localPath = await downloadFile(bot, photo.file_id, `photo_${Date.now()}.jpg`);
      await handleMessage(ctx, `[Image saved to ${localPath}]${caption ? `\n${caption}` : ""}`);
    } catch (err) {
      await ctx.reply(`⚠️ Failed to download image: ${err}`);
    }
  });

  bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    const caption = ctx.message.caption ?? "";
    try {
      const localPath = await downloadFile(bot, doc.file_id, doc.file_name ?? `file_${Date.now()}`);
      await handleMessage(ctx, `[File saved to ${localPath} (${doc.mime_type ?? "unknown type"})]${caption ? `\n${caption}` : ""}`);
    } catch (err) {
      await ctx.reply(`⚠️ Failed to download file: ${err}`);
    }
  });

  bot.on("message:voice", async (ctx) => {
    try {
      const localPath = await downloadFile(bot, ctx.message.voice.file_id, `voice_${Date.now()}.ogg`);
      await handleMessage(ctx, `[Voice message saved to ${localPath}. Transcribe with whisper or another tool if needed.]`);
    } catch (err) {
      await ctx.reply(`⚠️ Failed to download voice: ${err}`);
    }
  });

  // Catch grammY polling errors (e.g. 409 Conflict) to prevent process crashes
  bot.catch((err) => {
    console.error("[Telegram] Bot error:", err.message ?? err);
  });

  console.log(`[Telegram] Starting ${displayName}...`);
  bot.start({
    drop_pending_updates: true,
    onStart: (info) => console.log(`[Telegram] ${displayName} online as @${info.username}`),
  });
}
