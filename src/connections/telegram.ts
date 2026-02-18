/**
 * Telegram connection for AgentBox.
 *
 * Uses grammY (https://grammy.dev) — modern, TypeScript-first Telegram bot framework.
 * Supports text, files, images, voice. Auth via allowedUsers whitelist in agent config.
 *
 * Features:
 * - Streaming responses with live message edits (feels like typing)
 * - File/image/voice downloads from Telegram → agent (saves to /tmp)
 * - /clear, /model, /thinking, /status, /help commands
 */

import { Bot, Context } from "grammy";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { agentbox, type MessageSource } from "../agentbox.js";
import { type AgentEvent } from "@mariozechner/pi-agent-core";
import { type TextContent } from "@mariozechner/pi-ai";
import { loadAgentConfig, getAgentName } from "../config.js";

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
      `${displayName} online. Send me anything.\n\n` +
      `Commands:\n` +
      `/clear — clear conversation history\n` +
      `/status — show model + message count\n` +
      `/model <id> — switch model\n` +
      `/thinking — toggle extended thinking\n` +
      `/help — this message`
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      `/clear — clear conversation history\n` +
      `/status — show model + message count\n` +
      `/model <id> — switch model (e.g. /model claude-opus-4-5)\n` +
      `/thinking — toggle extended thinking\n` +
      `\nSend files/images and I'll receive them.`
    );
  });

  bot.command("clear", async (ctx) => {
    agentbox.clearMessages();
    await ctx.reply("✓ Conversation cleared.");
  });

  bot.command("status", async (ctx) => {
    const state = agentbox.instance.state;
    await ctx.reply(
      `Agent: ${displayName}\n` +
      `Model: ${state.model.id}\n` +
      `Messages: ${agentbox.messageCount}\n` +
      `Thinking: ${state.thinkingLevel ?? "off"}`
    );
  });

  bot.command("model", async (ctx) => {
    const modelId = ctx.match?.trim();
    if (!modelId) { await ctx.reply("Usage: /model <model-id>"); return; }
    agentbox.setModel(modelId);
    await ctx.reply(`✓ Switched to ${modelId}`);
  });

  bot.command("thinking", async (ctx) => {
    const current = agentbox.instance.state.thinkingLevel ?? "off";
    const next = current === "off" ? "medium" : "off";
    agentbox.setThinkingLevel(next);
    await ctx.reply(`✓ Thinking: ${next}`);
  });

  // ── Message handler ───────────────────────────────────────────────────────

  async function handleMessage(ctx: Context, content: string) {
    const source: MessageSource = {
      id: sourceId(ctx),
      label: `Telegram from ${ctx.from?.username ?? ctx.from?.id}`,
    };

    console.log(`[Telegram] ${ctx.from?.username}: ${content.slice(0, 80)}`);

    const sentMsg = await ctx.reply("…");
    let lastEditedText = "";
    let editTimeout: NodeJS.Timeout | null = null;

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
          } catch { /* message unchanged or deleted */ }
        }
      }, 1000);
    };

    const unsubscribe = agentbox.subscribe(`telegram-reply:${sourceId(ctx)}`, async (event: AgentEvent, evtSource: MessageSource) => {
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

        const lastAssistant = [...event.messages].reverse().find(m => (m as any).role === "assistant");
        let finalText = "";
        if (lastAssistant) {
          finalText = (lastAssistant as any).content
            .filter((c: any): c is TextContent => c.type === "text")
            .map((c: any) => c.text)
            .join("")
            .trim();
        }

        if (!finalText) finalText = "_(no response)_";

        if (finalText.length <= TELEGRAM_MAX_LENGTH) {
          try {
            await ctx.api.editMessageText(ctx.chat!.id, sentMsg.message_id, finalText);
          } catch { /* unchanged */ }
        } else {
          try { await ctx.api.deleteMessage(ctx.chat!.id, sentMsg.message_id); } catch {}
          for (const chunk of splitMessage(finalText)) await ctx.reply(chunk);
        }
      }
    });

    agentbox.prompt(content, source).catch(async (err) => {
      unsubscribe();
      if (editTimeout) { clearTimeout(editTimeout); editTimeout = null; }
      console.error("[Telegram] Agent error:", err);
      await ctx.api.editMessageText(
        ctx.chat!.id, sentMsg.message_id,
        `⚠️ Error: ${String(err).slice(0, 500)}`
      );
    });
  }

  // Plain text
  bot.on("message:text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) return;
    await handleMessage(ctx, ctx.message.text);
  });

  // Photos
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

  // Documents
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

  // Voice
  bot.on("message:voice", async (ctx) => {
    try {
      const localPath = await downloadFile(bot, ctx.message.voice.file_id, `voice_${Date.now()}.ogg`);
      await handleMessage(ctx, `[Voice message saved to ${localPath}]`);
    } catch (err) {
      await ctx.reply(`⚠️ Failed to download voice: ${err}`);
    }
  });

  console.log(`[Telegram] Starting ${displayName}...`);
  bot.start({
    onStart: (info) => console.log(`[Telegram] ${displayName} online as @${info.username}`),
  });
}
