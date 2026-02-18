/**
 * TUI connection for Rex.
 *
 * Terminal UI adapter — Ink-based chat interface.
 * Talks to the Rex singleton, same shared conversation as Discord.
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import TextInput from "ink-text-input";
import { type AgentEvent, type AgentMessage } from "@mariozechner/pi-agent-core";
import { type TextContent, type ToolCall } from "@mariozechner/pi-ai";
import { rex, type MessageSource } from "../rex.js";

const TUI_SOURCE: MessageSource = {
  id: "tui:local",
  label: "TUI (local terminal)",
};

// How many past messages to show before truncating
const MAX_VISIBLE_MESSAGES = 10;

interface ChatHistory {
  messages: AgentMessage[];
  streamingText: string;
  isStreaming: boolean;
}

function MessageView({ msg }: { msg: AgentMessage }) {
  if (msg.role === "user") {
    const text =
      typeof msg.content === "string"
        ? msg.content
        : msg.content
            .filter((c): c is TextContent => c.type === "text")
            .map(c => c.text)
            .join("");
    return (
      <Box marginY={0}>
        <Text color="cyan" bold>you&gt; </Text>
        <Text wrap="wrap">{text}</Text>
      </Box>
    );
  }

  if (msg.role === "assistant") {
    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];

    for (const part of msg.content) {
      if (part.type === "text") textParts.push(part.text);
      else if (part.type === "toolCall") toolCalls.push(part);
    }

    return (
      <Box flexDirection="column" marginY={0}>
        {textParts.length > 0 && (
          <Box>
            <Text color="green" bold>rex&gt; </Text>
            <Text wrap="wrap">{textParts.join("")}</Text>
          </Box>
        )}
        {toolCalls.map((tc, j) => (
          <Box key={j} marginLeft={2}>
            <Text color="yellow" bold>[{tc.name}] </Text>
            <Text color="gray">{JSON.stringify(tc.arguments).slice(0, 100)}</Text>
          </Box>
        ))}
      </Box>
    );
  }

  if (msg.role === "toolResult") {
    const text = msg.content
      .filter((c): c is TextContent => c.type === "text")
      .map(c => c.text)
      .join("");
    const preview = text.length > 200 ? text.slice(0, 200) + "…" : text;
    return (
      <Box marginLeft={2} marginY={0}>
        <Text color={msg.isError ? "red" : "gray"}>└─ {preview}</Text>
      </Box>
    );
  }

  return null;
}

function App() {
  const { exit } = useApp();
  const [appState, setAppState] = useState<"ready" | "responding" | "error">("ready");
  const [input, setInput] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [history, setHistory] = useState<ChatHistory>({
    messages: [],
    streamingText: "",
    isStreaming: false,
  });

  const streamingTextRef = useRef("");
  const updateTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const unsubscribe = rex.subscribe("tui", (event: AgentEvent, source: MessageSource) => {
      // Show all events in TUI regardless of source — you want to see what's happening
      switch (event.type) {
        case "agent_start":
          setAppState("responding");
          streamingTextRef.current = "";
          setHistory(prev => ({ ...prev, streamingText: "", isStreaming: true }));
          // Show where the message came from if not local
          if (source.id !== TUI_SOURCE.id) {
            streamingTextRef.current = `[via ${source.label}] `;
          }
          break;

        case "message_update":
          if (event.message.role === "assistant") {
            const text = event.message.content
              .filter((c): c is TextContent => c.type === "text")
              .map(c => c.text)
              .join("");
            streamingTextRef.current = text;

            if (updateTimeoutRef.current) clearTimeout(updateTimeoutRef.current);
            updateTimeoutRef.current = setTimeout(() => {
              setHistory(prev => ({ ...prev, streamingText: streamingTextRef.current }));
            }, 80);
          }
          break;

        case "agent_end":
          if (updateTimeoutRef.current) clearTimeout(updateTimeoutRef.current);
          setHistory({
            messages: [...event.messages],
            streamingText: "",
            isStreaming: false,
          });
          setAppState("ready");
          break;

        case "tool_execution_start":
          streamingTextRef.current += `\n[${event.toolName}] running...`;
          setHistory(prev => ({ ...prev, streamingText: streamingTextRef.current }));
          break;
      }
    });

    return () => {
      unsubscribe();
      if (updateTimeoutRef.current) clearTimeout(updateTimeoutRef.current);
    };
  }, []);

  const handleSubmit = useCallback(async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;

    setNotice(null);

    if (trimmed === "/exit" || trimmed === "/quit") { exit(); return; }

    if (trimmed === "/clear") {
      rex.clearMessages();
      setHistory({ messages: [], streamingText: "", isStreaming: false });
      setInput("");
      return;
    }

    if (trimmed.startsWith("/model ")) {
      const modelId = trimmed.slice(7).trim();
      rex.setModel(modelId);
      setNotice(`Switched to ${modelId}`);
      setInput("");
      return;
    }

    if (trimmed === "/thinking on") { rex.setThinkingLevel("medium"); setInput(""); return; }
    if (trimmed === "/thinking off") { rex.setThinkingLevel("off"); setInput(""); return; }

    if (trimmed === "/help") {
      setNotice([
        "/model <id>      switch model",
        "/thinking on|off toggle thinking",
        "/clear           clear history",
        "/exit            quit",
      ].join("\n"));
      setInput("");
      return;
    }

    setInput("");
    try {
      await rex.prompt(trimmed, TUI_SOURCE);
    } catch (err) {
      setNotice(String(err));
      setAppState("error");
    }
  }, [exit]);

  useInput((_, key) => {
    if (key.ctrl && key.return) {
      if (appState === "responding") rex.abort();
      else exit();
    }
  });

  const visibleMessages = useMemo(() => {
    const msgs = history.messages;
    return msgs.length > MAX_VISIBLE_MESSAGES
      ? msgs.slice(msgs.length - MAX_VISIBLE_MESSAGES)
      : msgs;
  }, [history.messages]);

  const truncated = history.messages.length > MAX_VISIBLE_MESSAGES;

  const statusLine = useMemo(() => {
    const modelId = rex.instance.state.model.id;
    const total = history.messages.length;
    const countStr = total > 0 ? ` • ${total} msgs` : "";
    return `rex @ agentbox • ${modelId}${countStr}`;
  }, [history.messages.length]);

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1}>
        <Text color="cyan" bold>{statusLine}</Text>
      </Box>

      {truncated && (
        <Box marginBottom={1} paddingX={1}>
          <Text color="gray" dimColor>↑ older messages hidden • /clear to reset</Text>
        </Box>
      )}

      <Box flexDirection="column" flexGrow={1}>
        {visibleMessages.map((msg, i) => (
          <MessageView
            key={`${history.messages.length - visibleMessages.length + i}-${msg.role}`}
            msg={msg}
          />
        ))}

        {history.isStreaming && (
          <Box marginY={0}>
            <Text color="green" bold>rex&gt; </Text>
            <Text wrap="wrap">{history.streamingText}</Text>
            <Text color="gray">▌</Text>
          </Box>
        )}
      </Box>

      {notice && (
        <Box marginY={1} borderStyle="round" borderColor="yellow" paddingX={1}>
          <Text color="yellow">{notice}</Text>
        </Box>
      )}

      <Box borderStyle="round" borderColor="gray" paddingX={1} marginTop={1}>
        {appState === "ready" ? (
          <Box>
            <Text color="cyan" bold>you&gt; </Text>
            <TextInput
              value={input}
              onChange={setInput}
              onSubmit={handleSubmit}
              placeholder="message… (/help)"
            />
          </Box>
        ) : (
          <Text color="gray">thinking… (Ctrl+Enter to abort)</Text>
        )}
      </Box>
    </Box>
  );
}

export async function startTUI(): Promise<void> {
  console.log("Starting Rex TUI...");
  render(<App />);
}
