/**
 * Terminal UI connection for AgentBox.
 * Uses Ink for a clean interactive terminal experience.
 */

import React, { useState } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import TextInput from "ink-text-input";
import { exec } from "child_process";
import { promisify } from "util";
import { agentbox, type MessageSource } from "../core/agentbox.js";
import { type AgentEvent } from "../core/agent.js";

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
      agentbox.clearMessages();
      setMessages([]);
      return;
    }
    if (trimmed.startsWith("/model ")) {
      const modelId = trimmed.slice(7).trim();
      agentbox.setModel(modelId);
      setMessages(prev => [...prev, { role: "system", content: `✓ Switched to ${modelId} (takes effect next turn)` }]);
      return;
    }
    if (trimmed === "/status") {
      setMessages(prev => [...prev, {
        role: "system",
        content: `Agent: ${agentbox.name}\nBackend: claude-code subprocess`,
      }]);
      return;
    }
    if (trimmed === "/update") {
      setMessages(prev => [...prev, { role: "system", content: "⬇️ Pulling latest code..." }]);
      execAsync("git pull --ff-only", { cwd: process.cwd() }).then(({ stdout }) => {
        const summary = stdout.trim();
        if (summary.includes("Already up to date")) {
          setMessages(prev => [...prev, { role: "system", content: "✓ Already up to date." }]);
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
        setStreamBuffer(prev => prev + event.text);
      }

      if (event.type === "done") {
        unsubscribe();
        setMessages(prev => {
          const text = prev[prev.length] as any; // captured via closure below
          return prev;
        });
        // Capture current stream buffer via a ref-like pattern
        setStreamBuffer(current => {
          const finalText = current.trim() || "(no response)";
          setMessages(prev => [...prev, { role: "assistant", content: finalText }]);
          setAppState("idle");
          return "";
        });
      }

      if (event.type === "error") {
        unsubscribe();
        setStreamBuffer("");
        setMessages(prev => [...prev, { role: "system", content: `⚠️ Error: ${event.message}` }]);
        setAppState("idle");
      }
    });

    agentbox.prompt(trimmed, TUI_SOURCE).catch(err => {
      unsubscribe();
      setStreamBuffer("");
      setMessages(prev => [...prev, { role: "system", content: `Error: ${err.message}` }]);
      setAppState("idle");
    });
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Text color="cyan" bold>{agentbox.name} @ agentbox • claude-code</Text>
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
