/**
 * Discord connection for Rex.
 *
 * Pure I/O adapter — receives Discord messages, sends them to Rex,
 * streams replies back. No agent logic here.
 */

import {
  Client,
  GatewayIntentBits,
  Message,
  Events,
  ActivityType,
  ChannelType,
  TextChannel,
  DMChannel,
} from "discord.js";
import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { type AgentEvent } from "@mariozechner/pi-agent-core";
import { type TextContent } from "@mariozechner/pi-ai";
import { rex, type MessageSource } from "../rex.js";
import { hasCredentials, login } from "../auth.js";

interface ClawdbotConfig {
  channels?: {
    discord?: {
      token?: string;
      enabled?: boolean;
      dm?: { enabled?: boolean; policy?: string; allowFrom?: string[] };
      guilds?: Record<string, { channels?: Record<string, { allow?: boolean }> }>;
    };
  };
}

async function loadDiscordConfig(): Promise<{
  token: string;
  allowedChannels: Set<string>;
  allowedUsers: Set<string>;
}> {
  const configPath = join(homedir(), ".clawdbot", "clawdbot.json");
  const raw = await readFile(configPath, "utf-8");
  const config: ClawdbotConfig = JSON.parse(raw);

  const discord = config.channels?.discord;
  if (!discord?.token) throw new Error("No Discord token in ~/.clawdbot/clawdbot.json");

  const allowedChannels = new Set<string>();
  const allowedUsers = new Set<string>(discord.dm?.allowFrom ?? []);

  for (const [, guild] of Object.entries(discord.guilds ?? {})) {
    for (const [channelId, channelConfig] of Object.entries(guild.channels ?? {})) {
      if (channelConfig.allow) allowedChannels.add(channelId);
    }
  }

  return { token: discord.token, allowedChannels, allowedUsers };
}

/**
 * Keeps typing indicator alive while fn() runs.
 * Discord indicators expire after ~10s so we re-send every 8s.
 */
async function withTyping<T>(
  channel: TextChannel | DMChannel,
  fn: () => Promise<T>
): Promise<T> {
  let stopped = false;

  const keepTyping = async () => {
    while (!stopped) {
      try { await channel.sendTyping(); } catch { /* channel gone, ignore */ }
      await new Promise(res => setTimeout(res, 8000));
    }
  };

  const typingLoop = keepTyping();
  try {
    return await fn();
  } finally {
    stopped = true;
    await typingLoop;
  }
}

function splitMessage(text: string, maxLen: number): string[] {
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

export async function startDiscord(): Promise<void> {
  const hasAuth = await hasCredentials("anthropic");
  if (!hasAuth) {
    console.log("[Discord] Authenticating with Anthropic...");
    const ok = await login("anthropic");
    if (!ok) throw new Error("Anthropic auth failed");
  }

  const { token, allowedChannels, allowedUsers } = await loadDiscordConfig();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
  });

  client.once(Events.ClientReady, (c) => {
    console.log(`[Discord] Rex online as ${c.user.tag}`);
    c.user.setActivity("the machine", { type: ActivityType.Watching });
  });

  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;

    const isDM = message.channel.type === ChannelType.DM;
    const channelId = message.channelId;
    const authorId = message.author.id;

    if (isDM) {
      if (!allowedUsers.has(authorId)) {
        console.log(`[Discord] Blocked DM from ${authorId}`);
        return;
      }
    } else {
      if (!allowedChannels.has(channelId)) return;
    }

    const content = message.content.trim();
    if (!content) return;

    const source: MessageSource = {
      id: `discord:${channelId}`,
      label: `Discord ${isDM ? "DM" : `#${channelId}`} from ${message.author.username}`,
    };

    console.log(`[Discord] ${message.author.username} in ${isDM ? "DM" : channelId}: ${content.slice(0, 80)}`);

    const channel = message.channel as TextChannel | DMChannel;

    try {
      // Collect the final response text while keeping typing alive
      const responseText = await withTyping(channel, () => {
        return new Promise<string>((resolve, reject) => {
          let finalText = "";

          const unsubscribe = rex.subscribe(`discord-reply:${channelId}`, (event: AgentEvent, evtSource: MessageSource) => {
            // Only handle events from this specific message's source
            if (evtSource.id !== source.id) return;

            if (event.type === "tool_execution_start") {
              console.log(`[Rex via Discord] Tool: ${event.toolName}`);
            }

            if (event.type === "agent_end") {
              unsubscribe();
              const msgs = event.messages;
              const lastAssistant = [...msgs].reverse().find(m => (m as any).role === "assistant");
              if (lastAssistant) {
                finalText = (lastAssistant as any).content
                  .filter((c: any): c is TextContent => c.type === "text")
                  .map((c: any) => c.text)
                  .join("")
                  .trim();
              }
              resolve(finalText || "_(no text response)_");
            }

          });

          rex.prompt(content, source).catch(err => {
            unsubscribe();
            reject(err);
          });
        });
      });

      const chunks = splitMessage(responseText, 1900);
      for (const chunk of chunks) {
        await message.reply(chunk);
      }
    } catch (err) {
      console.error("[Discord] Agent error:", err);
      await message.reply(`⚠️ Error: ${String(err).slice(0, 500)}`);
    }
  });

  await client.login(token);
}
