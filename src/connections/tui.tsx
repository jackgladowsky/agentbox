/**
 * Terminal UI connection for AgentBox.
 * Uses Ink for a clean interactive terminal experience.
 */

import React, { useState, useEffect, useRef } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import TextInput from "ink-text-input";
import { exec } from "child_process";
import { promisify } from "util";
import { agentbox, type MessageSource } from "../core/agentbox.js";
import { type AgentEvent, type AgentMessage } from "@mariozechner/pi-agent-core";
import { type AssistantMessage, type TextContent } from "@mariozechner/pi-ai";

const execAsync = promisify(exec);

type AppState = "idle" | "responding";

interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

const TUI_SOURCE: MessageSource = { id: "tui:local", label: "TUI" };

// ── Type helpers ──────────────────────────────────────────────────────────────

/** Type guard: narrow AgentMessage to AssistantMessage. */
function isAssistantMessage(msg: AgentMessage): msg is AssistantMessage {
  return (msg as AssistantMessage).role === "assistant";
}

/** Extract plain text from an AssistantMessage's content array. */
function extractAssistantText(msg: AssistantMessage): string {
  return msg.content
    .filter((c): c is TextContent => c.type === "text")
    .map(c => c.text)
    .join("");
}

// ── Component ─────────────────────────────────────────────────────────────────

function AgentBoxTUI() {
  const { exit } = useApp();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [appState, setAppState] = useState<AppState>("idle");
  const [streamBuffer, setStreamBuffer] = useState("");

  useInput((inputChar, key) => {
    if (key.ctrl && inputChar === "c") {
      if (appState === "responding") {
        agentbox.abort();
      } else {
        exit();
      }
    }
  });

  const handleSubmit = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setInput("");

    // Commands
    if (trimmed === "/clear" || trimmed === "/reset" || trimmed === "/new") {
      agentbox.clearMessages();
      setMessages([]);
      return;
    }
    if (trimmed.startsWith("/model ")) {
      const modelId = trimmed.slice(7).trim();
      agentbox.setModel(modelId);
      setMessages(prev => [...prev, { role: "system", content: `✓ Switched to ${modelId}` }]);
      return;
    }
    if (trimmed === "/thinking") {
      const current = agentbox.instance.state.thinkingLevel ?? "off";
      const next = current === "off" ? "medium" : "off";
      agentbox.setThinkingLevel(next);
      setMessages(prev => [...prev, { role: "system", content: `✓ Thinking: ${next}` }]);
      return;
    }
    if (trimmed === "/status") {
      const state = agentbox.instance.state;
      setMessages(prev => [...prev, {
        role: "system",
        content: `Agent: ${agentbox.name}\nModel: ${state.model.id}\nMessages: ${agentbox.messageCount}\nThinking: ${state.thinkingLevel ?? "off"}`
      }]);
      return;
    }
    if (trimmed === "/update") {
      setMessages(prev => [...prev, { role: "system", content: "⬇️ Pulling latest code..." }]);
      execAsync("git pull --ff-only", { cwd: process.cwd() }).then(({ stdout }) => {
        const summary = stdout.trim();
        if (summary.includes("Already up to date")) {
          setMessages(prev => [...prev, { role: "system", content: "✓ Already up to date. No restart needed." }]);
        } else {
          setMessages(prev => [...prev, { role: "system", content: `✓ Updated:\n${summary}\n\nRestarting...` }]);
          setTimeout(() => process.kill(process.pid, "SIGTERM"), 1500);
        }
      }).catch((err: Error) => {
        setMessages(prev => [...prev, { role: "system", content: `⚠️ Update failed:\n${err.message}` }]);
      });
      return;
    }

    setMessages(prev => [...prev, { role: "user", content: trimmed }]);
    setAppState("responding");
    setStreamBuffer("");

    const unsubscribe = agentbox.subscribe("tui", (event: AgentEvent) => {
      if (event.type === "message_update" && isAssistantMessage(event.message)) {
        const text = extractAssistantText(event.message);
        setStreamBuffer(text);
      }

      if (event.type === "agent_end") {
        unsubscribe();
        const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
        const finalText = lastAssistant
          ? extractAssistantText(lastAssistant).trim()
          : "";
        setStreamBuffer("");
        setMessages(prev => [...prev, { role: "assistant", content: finalText || "(no response)" }]);
        setAppState("idle");
      }
    });


    agentbox.prompt(trimmed, TUI_SOURCE).catch(err => {
      unsubscribe();
      setMessages(prev => [...prev, { role: "system", content: `Error: ${err.message}` }]);
      setAppState("idle");
    });
  };

  const modelId = agentbox.instance.state.model.id;
  const countStr = agentbox.messageCount > 0 ? ` • ${agentbox.messageCount} msgs` : "";
  const title = `${agentbox.name} @ agentbox • ${modelId}${countStr}`;

  return (
    <Box flexDirection="column" padding={1}>
      <Text color="cyan" bold>{title}</Text>
      <Text color="gray">─────────────────────────────────────────</Text>

      <Box flexDirection="column" marginTop={1}>
        {messages.map((msg, i) => (
          <Box key={i} marginBottom={1} flexDirection="column">
            {msg.role === "user" && (
              <Box>
                <Text color="green" bold>you › </Text>
                <Text>{msg.content}</Text>
              </Box>
            )}
            {msg.role === "assistant" && (
              <Box>
                <Text color="cyan" bold>{agentbox.name} › </Text>
                <Text>{msg.content}</Text>
              </Box>
            )}
            {msg.role === "system" && (
              <Text color="yellow">{msg.content}</Text>
            )}
          </Box>
        ))}

        {appState === "responding" && streamBuffer && (
          <Box>
            <Text color="cyan" bold>{agentbox.name} › </Text>
            <Text color="gray">{streamBuffer}</Text>
          </Box>
        )}

        {appState === "responding" && !streamBuffer && (
          <Text color="gray" dimColor>thinking...</Text>
        )}
      </Box>

      <Box marginTop={1}>
        <Text color="green" bold>you › </Text>
        {appState === "idle" ? (
          <TextInput
            value={input}
            onChange={setInput}
            onSubmit={handleSubmit}
            placeholder="type a message..."
          />
        ) : (
          <Text color="gray" dimColor>responding... (ctrl+c to abort)</Text>
        )}
      </Box>
    </Box>
  );
}

export async function startTUI(): Promise<void> {
  console.log("Starting AgentBox TUI...");
  render(<AgentBoxTUI />);
}
