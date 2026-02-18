import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import TextInput from "ink-text-input";
import { Agent, type AgentEvent, type AgentMessage } from "@mariozechner/pi-agent-core";
import { type TextContent, type ToolCall } from "@mariozechner/pi-ai";
import { createAgent, DEFAULT_MODEL } from "./agent.js";
import { hasCredentials, login } from "./auth.js";
import { loadWorkspaceContext, type WorkspaceContext } from "./workspace.js";

type AppState = "ready" | "responding" | "error";

// How many past messages to show in the terminal window
const MAX_VISIBLE_MESSAGES = 10;

interface ChatHistory {
  messages: AgentMessage[];
  streamingText: string;
  isStreaming: boolean;
}

interface Props {
  agent: Agent;
  context: WorkspaceContext;
}

function MessageView({ msg, index }: { msg: AgentMessage; index: number }) {
  if (msg.role === "user") {
    const text = typeof msg.content === "string"
      ? msg.content
      : msg.content.filter((c): c is TextContent => c.type === "text").map(c => c.text).join("");
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

function App({ agent, context }: Props) {
  const { exit } = useApp();
  const [state, setState] = useState<AppState>("ready");
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<ChatHistory>({
    messages: [],
    streamingText: "",
    isStreaming: false,
  });

  const streamingTextRef = useRef("");
  const updateTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const unsubscribe = agent.subscribe((event: AgentEvent) => {
      switch (event.type) {
        case "agent_start":
          setState("responding");
          streamingTextRef.current = "";
          setHistory(prev => ({ ...prev, streamingText: "", isStreaming: true }));
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
          setState("ready");
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
  }, [agent]);

  const handleSubmit = useCallback(async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;

    setError(null);

    if (trimmed === "/exit" || trimmed === "/quit") { exit(); return; }

    if (trimmed === "/clear") {
      agent.clearMessages();
      setHistory({ messages: [], streamingText: "", isStreaming: false });
      setInput("");
      return;
    }

    if (trimmed.startsWith("/model ")) {
      const modelId = trimmed.slice(7).trim();
      try {
        agent.setModel({ ...DEFAULT_MODEL, id: modelId });
        setError(`Switched to ${modelId}`);
      } catch {
        setError(`Unknown model: ${modelId}`);
      }
      setInput("");
      return;
    }

    if (trimmed === "/thinking on") { agent.setThinkingLevel("medium"); setInput(""); return; }
    if (trimmed === "/thinking off") { agent.setThinkingLevel("off"); setInput(""); return; }

    if (trimmed === "/help") {
      setError([
        "/model <id>   switch model",
        "/thinking on|off",
        "/clear        clear history",
        "/exit         quit",
      ].join("\n"));
      setInput("");
      return;
    }

    setInput("");
    try {
      await agent.prompt(trimmed);
    } catch (err) {
      setError(String(err));
      setState("error");
    }
  }, [agent, exit]);

  useInput((_, key) => {
    if (key.ctrl && key.return) {
      if (state === "responding") agent.abort();
      else exit();
    }
  });

  // Only show last N messages to avoid flicker on long conversations
  const visibleMessages = useMemo(() => {
    const msgs = history.messages;
    const trimmed = msgs.length > MAX_VISIBLE_MESSAGES
      ? msgs.slice(msgs.length - MAX_VISIBLE_MESSAGES)
      : msgs;
    return trimmed;
  }, [history.messages]);

  const truncated = history.messages.length > MAX_VISIBLE_MESSAGES;

  const statusLine = useMemo(() => {
    const modelName = agent.state.model.id;
    const total = history.messages.length;
    const countStr = total > 0 ? ` • ${total} msgs` : "";
    return `rex @ agentbox • ${modelName}${countStr}`;
  }, [agent.state.model.id, history.messages.length]);

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1}>
        <Text color="cyan" bold>{statusLine}</Text>
      </Box>

      {/* Truncation notice */}
      {truncated && (
        <Box marginBottom={1} paddingX={1}>
          <Text color="gray" dimColor>↑ older messages hidden • /clear to reset</Text>
        </Box>
      )}

      {/* Message history - capped */}
      <Box flexDirection="column" flexGrow={1}>
        {visibleMessages.map((msg, i) => (
          <MessageView key={`${history.messages.length - visibleMessages.length + i}-${msg.role}`} msg={msg} index={i} />
        ))}

        {/* Streaming */}
        {history.isStreaming && (
          <Box marginY={0}>
            <Text color="green" bold>rex&gt; </Text>
            <Text wrap="wrap">{history.streamingText}</Text>
            <Text color="gray">▌</Text>
          </Box>
        )}
      </Box>

      {/* Error / info */}
      {error && (
        <Box marginY={1} borderStyle="round" borderColor="yellow" paddingX={1}>
          <Text color="yellow">{error}</Text>
        </Box>
      )}

      {/* Input */}
      <Box borderStyle="round" borderColor="gray" paddingX={1} marginTop={1}>
        {state === "ready" ? (
          <Box>
            <Text color="cyan" bold>you&gt; </Text>
            <TextInput
              value={input}
              onChange={setInput}
              onSubmit={handleSubmit}
              placeholder="message... (/help)"
            />
          </Box>
        ) : (
          <Text color="gray">thinking… (Ctrl+Enter to abort)</Text>
        )}
      </Box>
    </Box>
  );
}

async function main() {
  const hasAuth = await hasCredentials("anthropic");
  if (!hasAuth) {
    console.log("No Anthropic credentials found.");
    const success = await login("anthropic");
    if (!success) {
      console.error("Could not authenticate. Run 'claude' first.");
      process.exit(1);
    }
  }

  console.log("Starting AgentBox...");
  const context = await loadWorkspaceContext(process.cwd());
  const agent = createAgent(context.systemPrompt);
  console.log(`Rex ready — ${agent.state.model.id}`);

  render(<App agent={agent} context={context} />);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
