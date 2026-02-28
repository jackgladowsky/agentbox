/**
 * Terminal UI connection for AgentBox.
 * Uses Ink for a clean interactive terminal experience.
 */

import React, { useState } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import TextInput from "ink-text-input";
import { exec } from "child_process";
import { promisify } from "util";
import { agentbox, type MessageSource, type AgentEvent } from "../core/agentbox.js";

const execAsync = promisify(exec);

type AppState = "idle" | "responding";

interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

const TUI_SOURCE: MessageSource = { id: "tui:local", label: "TUI" };

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
      await agentbox.clearSession();
      setMessages([]);
      return;
    }
    if (trimmed.startsWith("/model ")) {
      const modelId = trimmed.slice(7).trim();
      agentbox.setModel(modelId);
      setMessages(prev => [...prev, { role: "system", content: `✓ Switched to ${modelId}` }]);
      return;
    }
    if (trimmed === "/status") {
      const session = agentbox.sessionId ?? "none";
      setMessages(prev => [...prev, {
        role: "system",
        content: `Agent: ${agentbox.name}\nModel: ${agentbox.modelId}\nSession: ${session}`
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
      if (event.type === "text_delta") {
        setStreamBuffer(event.text);
      }

      if (event.type === "agent_end") {
        unsubscribe();
        setStreamBuffer("");
        setMessages(prev => [...prev, { role: "assistant", content: event.result.trim() || "(no response)" }]);
        setAppState("idle");
      }
    });


    agentbox.prompt(trimmed, TUI_SOURCE).catch(err => {
      unsubscribe();
      setMessages(prev => [...prev, { role: "system", content: `Error: ${err.message}` }]);
      setAppState("idle");
    });
  };

  const title = `${agentbox.name} @ agentbox • ${agentbox.modelId}`;

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
