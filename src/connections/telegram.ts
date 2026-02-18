/**
 * Telegram connection for Rex.
 *
 * Uses grammY (https://grammy.dev) — modern, TypeScript-first Telegram bot framework.
 * Supports text, files, images, voice. Restricted to your user ID only.
 *
 * Features:
 * - Streaming responses with live message edits (feels like typing)
 * - File/image uploads from Rex → Telegram
 * - File/image downloads from Telegram → Rex (saves to /tmp)
 * - /clear, /model, /thinking, /status commands
 */

import { Bot, Context, InputFile } from "grammy";
import { createReadStream, existsSync } from "fs";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir, homedir } from "os";
import { rex, type MessageSource } from "../rex.js";
import { type AgentEvent } from "@mariozechner/pi-agent-core";
import { type TextContent } from "@mariozechner/pi-ai";
import { readFile } from "fs/promises";

// ── Config ────────────────────────────────────────────────────────────────────

interface TelegramConfig {
  token: string;
  allowedUsers: number[]; // Telegram user IDs
}

async function loadConfig(): Promise<TelegramConfig> {
  const configPath = join(homedir(), ".config", "rex", "telegram.json");
  try {
    const raw = await readFile(configPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    throw new Error(
      `No Telegram config found at ${configPath}\n` +
      `Create it with:\n` +
      `  mkdir -p ~/.config/rex\n` +
      `  echo '{"token":"YOUR_BOT_TOKEN","allowedUsers":[YOUR_USER_ID]}' > ${configPath}`
    );
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// Download a Telegram file to /tmp and return the local path
async function downloadFile(bot: Bot, fileId: string, filename: string): Promise<string> {
  const file = await bot.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${(bot as any).token}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download file: ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const dir = join(tmpdir(), "rex-uploads");
  await mkdir(dir, { recursive: true });
  const localPath = join(dir, filename);
  await writeFile(localPath, buf);
  return localPath;
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function startTelegram(): Promise<void> {
  const config = await loadConfig();
  const bot = new Bot(config.token);
  const allowed = new Set(config.allowedUsers);

  // Auth middleware — drop everything from non-allowed users
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId || !allowed.has(userId)) {
      console.log(`[Telegram] Blocked user ${userId}`);
      return;
    }
    await next();
  });

  // ── Commands ──────────────────────────────────────────────────────────────

  bot.command("start", async (ctx) => {
    await ctx.reply(
      "Rex online. Send me anything.\n\n" +
      "Commands:\n" +
      "/clear — clear conversation history\n" +
      "/status — show model + message count\n" +
      "/model <id> — switch model\n" +
      "/thinking — toggle extended thinking\n" +
      "/help — this message"
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      "/clear — clear conversation history\n" +
      "/status — show model + message count\n" +
      "/model <id> — switch model (e.g. /model claude-opus-4-5)\n" +
      "/thinking — toggle extended thinking\n" +
      "\nSend files/images and I'll receive them.\n" +
      "I can send files back to you too."
    );
  });

  bot.command("clear", async (ctx) => {
    rex.clearMessages();
    await ctx.reply("✓ Conversation cleared.");
  });

  bot.command("status", async (ctx) => {
    const state = rex.instance.state;
    const msgCount = rex.messageCount;
    await ctx.reply(
      `Model: ${state.model.id}\n` +
      `Messages: ${msgCount}\n` +
      `Thinking: ${state.thinkingLevel ?? "off"}`
    );
  });

  bot.command("model", async (ctx) => {
    const modelId = ctx.match?.trim();
    if (!modelId) { await ctx.reply("Usage: /model <model-id>"); return; }
    rex.setModel(modelId);
    await ctx.reply(`✓ Switched to ${modelId}`);
  });

  bot.command("thinking", async (ctx) => {
    const current = rex.instance.state.thinkingLevel ?? "off";
    const next = current === "off" ? "medium" : "off";
    rex.setThinkingLevel(next);
    await ctx.reply(`✓ Thinking: ${next}`);
  });

  // ── Message handler (text + files) ────────────────────────────────────────

  async function handleMessage(ctx: Context, content: string) {
    const source: MessageSource = {
      id: sourceId(ctx),
      label: `Telegram from ${ctx.from?.username ?? ctx.from?.id}`,
    };

    console.log(`[Telegram] ${ctx.from?.username}: ${content.slice(0, 80)}`);

    // Send initial "thinking" message we'll edit as Rex streams
    const sentMsg = await ctx.reply("…");
    let lastEditedText = "";
    let editTimeout: NodeJS.Timeout | null = null;

    // Throttled edit — Telegram rate-limits edits to ~1/sec per message
    const scheduleEdit = (text: string) => {
      if (editTimeout) return;
      editTimeout = setTimeout(async () => {
        editTimeout = null;
        if (text !== lastEditedText && text.trim()) {
          try {
            const truncated = text.length > TELEGRAM_MAX_LENGTH
              ? text.slice(0, TELEGRAM_MAX_LENGTH - 3) + "…"
              : text;
            await ctx.api.editMessageText(ctx.chat!.id, sentMsg.message_id, truncated);
            lastEditedText = text;
          } catch { /* message unchanged or deleted, ignore */ }
        }
      }, 1000);
    };

    const unsubscribe = rex.subscribe(`telegram-reply:${sourceId(ctx)}`, async (event: AgentEvent, evtSource: MessageSource) => {
      if (evtSource.id !== source.id) return;

      if (event.type === "message_update" && event.message.role === "assistant") {
        const text = event.message.content
          .filter((c): c is TextContent => c.type === "text")
          .map(c => c.text)
          .join("");
        if (text) scheduleEdit(text);
      }

      if (event.type === "agent_end") {
        unsubscribe();
        if (editTimeout) { clearTimeout(editTimeout); editTimeout = null; }

        const msgs = event.messages;
        const lastAssistant = [...msgs].reverse().find(m => (m as any).role === "assistant");
        let finalText = "";
        if (lastAssistant) {
          finalText = (lastAssistant as any).content
            .filter((c: any): c is TextContent => c.type === "text")
            .map((c: any) => c.text)
            .join("")
            .trim();
        }

        if (!finalText) finalText = "_(no response)_";

        // If final text fits in one message, edit in place
        if (finalText.length <= TELEGRAM_MAX_LENGTH) {
          try {
            await ctx.api.editMessageText(ctx.chat!.id, sentMsg.message_id, finalText);
          } catch {
            // If edit fails (unchanged), that's fine
          }
        } else {
          // Delete the placeholder and send chunks
          try { await ctx.api.deleteMessage(ctx.chat!.id, sentMsg.message_id); } catch {}
          const chunks = splitMessage(finalText);
          for (const chunk of chunks) {
            await ctx.reply(chunk);
          }
        }
      }
    });

    rex.prompt(content, source).catch(async (err) => {
      unsubscribe();
      if (editTimeout) { clearTimeout(editTimeout); editTimeout = null; }
      console.error("[Telegram] Agent error:", err);
      await ctx.api.editMessageText(
        ctx.chat!.id,
        sentMsg.message_id,
        `⚠️ Error: ${String(err).slice(0, 500)}`
      );
    });
  }

  // Plain text
  bot.on("message:text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) return; // handled by command handlers
    await handleMessage(ctx, ctx.message.text);
  });

  // Photos — download and tell Rex where they are
  bot.on("message:photo", async (ctx) => {
    const photo = ctx.message.photo.at(-1)!; // largest size
    const caption = ctx.message.caption ?? "";
    try {
      const localPath = await downloadFile(bot, photo.file_id, `photo_${Date.now()}.jpg`);
      const content = `[Image saved to ${localPath}]${caption ? `\n${caption}` : ""}`;
      await handleMessage(ctx, content);
    } catch (err) {
      await ctx.reply(`⚠️ Failed to download image: ${err}`);
    }
  });

  // Documents / files
  bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    const caption = ctx.message.caption ?? "";
    try {
      const localPath = await downloadFile(bot, doc.file_id, doc.file_name ?? `file_${Date.now()}`);
      const content = `[File saved to ${localPath} (${doc.mime_type ?? "unknown type"})]${caption ? `\n${caption}` : ""}`;
      await handleMessage(ctx, content);
    } catch (err) {
      await ctx.reply(`⚠️ Failed to download file: ${err}`);
    }
  });

  // Voice messages
  bot.on("message:voice", async (ctx) => {
    try {
      const localPath = await downloadFile(bot, ctx.message.voice.file_id, `voice_${Date.now()}.ogg`);
      await handleMessage(ctx, `[Voice message saved to ${localPath}]`);
    } catch (err) {
      await ctx.reply(`⚠️ Failed to download voice: ${err}`);
    }
  });

  console.log("[Telegram] Starting bot...");
  bot.start({
    onStart: (info) => console.log(`[Telegram] Rex online as @${info.username}`),
  });
}
