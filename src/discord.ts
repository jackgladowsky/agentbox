/**
 * Discord interface for Rex.
 * Connects to the existing Discord bot token from clawdbot config.
 * Rex responds to messages in allowed channels and DMs.
 */

import {
  Client,
  GatewayIntentBits,
  Message,
  Events,
  ActivityType,
  ChannelType,
} from "discord.js";
import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { createAgent } from "./agent.js";
import { hasCredentials, login } from "./auth.js";

// Per-channel agent instances so each channel gets its own conversation context
const channelAgents = new Map<string, ReturnType<typeof createAgent>>();

function getOrCreateAgent(channelId: string): ReturnType<typeof createAgent> {
  if (!channelAgents.has(channelId)) {
    const agent = createAgent(
      `You are Rex, an autonomous AI agent running on Jack's server (jacks-server). 
You have full shell access and can execute commands, read/write files, and manage the system.
You're talking to Jack (or someone he's allowed) via Discord.
Be direct, capable, and useful. No fluff.`
    );
    channelAgents.set(channelId, agent);
  }
  return channelAgents.get(channelId)!;
}

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

async function loadDiscordConfig(): Promise<{ token: string; allowedChannels: Set<string>; allowedUsers: Set<string> }> {
  const configPath = join(homedir(), ".clawdbot", "clawdbot.json");
  const raw = await readFile(configPath, "utf-8");
  const config: ClawdbotConfig = JSON.parse(raw);

  const discord = config.channels?.discord;
  if (!discord?.token) throw new Error("No Discord token found in ~/.clawdbot/clawdbot.json");

  const allowedChannels = new Set<string>();
  const allowedUsers = new Set<string>(discord.dm?.allowFrom ?? []);

  // Collect all explicitly allowed channel IDs
  for (const [, guild] of Object.entries(discord.guilds ?? {})) {
    for (const [channelId, channelConfig] of Object.entries(guild.channels ?? {})) {
      if (channelConfig.allow) allowedChannels.add(channelId);
    }
  }

  return { token: discord.token, allowedChannels, allowedUsers };
}

async function run() {
  // Ensure Claude auth is set up
  const hasAuth = await hasCredentials("anthropic");
  if (!hasAuth) {
    console.log("Authenticating with Anthropic...");
    const ok = await login("anthropic");
    if (!ok) { console.error("Auth failed"); process.exit(1); }
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
    console.log(`Rex is online as ${c.user.tag}`);
    c.user.setActivity("the machine", { type: ActivityType.Watching });
  });

  client.on(Events.MessageCreate, async (message: Message) => {
    // Ignore bots (including self)
    if (message.author.bot) return;

    const isDM = message.channel.type === ChannelType.DM;
    const channelId = message.channelId;
    const authorId = message.author.id;

    // Access control
    if (isDM) {
      if (!allowedUsers.has(authorId)) {
        console.log(`Blocked DM from unknown user ${authorId}`);
        return;
      }
    } else {
      if (!allowedChannels.has(channelId)) return;
    }

    const content = message.content.trim();
    if (!content) return;

    console.log(`[Discord] ${message.author.username} in ${isDM ? "DM" : channelId}: ${content.slice(0, 80)}`);

    // Show typing indicator while thinking
    if ("sendTyping" in message.channel) {
      await message.channel.sendTyping();
    }

    const agent = getOrCreateAgent(channelId);

    try {
      // Collect the full streamed response
      let responseText = "";

      const result = await new Promise<string>((resolve, reject) => {
        const unsubscribe = agent.subscribe((event) => {
          if (event.type === "agent_end") {
            unsubscribe();
            // Get the last assistant message text
            const msgs = event.messages;
            const lastAssistant = [...msgs].reverse().find(m => m.role === "assistant");
            if (lastAssistant) {
              const text = lastAssistant.content
                .filter((c): c is { type: "text"; text: string } => c.type === "text")
                .map(c => c.text)
                .join("");
              resolve(text);
            } else {
              resolve("(no response)");
            }
          }
        });

        agent.prompt(content).catch(err => {
          unsubscribe();
          reject(err);
        });
      });

      // Discord has a 2000 char limit per message — chunk if needed
      const chunks = splitMessage(result, 1900);
      for (const chunk of chunks) {
        await message.reply(chunk);
      }
    } catch (err) {
      console.error("Agent error:", err);
      await message.reply(`⚠️ Error: ${String(err).slice(0, 500)}`);
    }
  });

  await client.login(token);
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    let chunk = remaining.slice(0, maxLen);
    // Try to break at newline
    const lastNewline = chunk.lastIndexOf("\n");
    if (lastNewline > maxLen * 0.5) chunk = remaining.slice(0, lastNewline);
    chunks.push(chunk);
    remaining = remaining.slice(chunk.length).trimStart();
  }
  return chunks;
}

run().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
