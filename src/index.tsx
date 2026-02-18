import React, { useState, useEffect, useCallback } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import TextInput from "ink-text-input";
import { Agent, type AgentEvent, type AgentMessage } from "@mariozechner/pi-agent-core";
import { type TextContent, type ThinkingContent, type ToolCall } from "@mariozechner/pi-ai";
import { createAgent, DEFAULT_MODEL } from "./agent.js";
import { hasCredentials, login } from "./auth.js";
import { loadWorkspaceContext, type WorkspaceContext } from "./workspace.js";

// App state
type AppState = "loading" | "ready" | "responding" | "error";

interface Props {
  agent: Agent;
  context: WorkspaceContext;
}

function App({ agent, context }: Props) {
  const { exit } = useApp();
  const [state, setState] = useState<AppState>("ready");
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [streamText, setStreamText] = useState("");
  const [messages, setMessages] = useState<AgentMessage[]>([]);

  // Subscribe to agent events
  useEffect(() => {
    const unsubscribe = agent.subscribe((event: AgentEvent) => {
      switch (event.type) {
        case "agent_start":
          setState("responding");
          setStreamText("");
          break;
          
        case "message_update":
          // Extract text from streaming message
          if (event.message.role === "assistant") {
            const textParts = event.message.content
              .filter((c): c is TextContent => c.type === "text")
              .map((c) => c.text);
            setStreamText(textParts.join(""));
          }
          break;
          
        case "agent_end":
          setMessages([...event.messages]);
          setState("ready");
          setStreamText("");
          break;
          
        case "tool_execution_start":
          setStreamText((prev) => prev + `\n[${event.toolName}] executing...`);
          break;
          
        case "tool_execution_end":
          // Tool result will be in next message
          break;
      }
    });

    return () => unsubscribe();
  }, [agent]);

  const handleSubmit = useCallback(async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;

    // Commands
    if (trimmed === "/exit" || trimmed === "/quit") {
      exit();
      return;
    }
    if (trimmed === "/clear") {
      agent.clearMessages();
      setMessages([]);
      setInput("");
      return;
    }
    if (trimmed.startsWith("/model ")) {
      const modelId = trimmed.slice(7).trim();
      agent.setModel({ ...DEFAULT_MODEL, id: modelId });
      setInput("");
      return;
    }
    if (trimmed === "/thinking on") {
      agent.setThinkingLevel("medium");
      setInput("");
      return;
    }
    if (trimmed === "/thinking off") {
      agent.setThinkingLevel("off");
      setInput("");
      return;
    }

    setInput("");
    setError(null);

    try {
      await agent.prompt(trimmed);
    } catch (err) {
      setError(String(err));
      setState("error");
    }
  }, [agent, exit]);

  // Handle Ctrl+C
  useInput((_, key) => {
    if (key.ctrl && (key.return || key.escape)) {
      if (state === "responding") {
        agent.abort();
      } else {
        exit();
      }
    }
  });

  // Render a message
  const renderMessage = (msg: AgentMessage, i: number) => {
    if (msg.role === "user") {
      const text = typeof msg.content === "string" 
        ? msg.content 
        : msg.content.filter((c): c is TextContent => c.type === "text").map(c => c.text).join("");
      return (
        <Box key={i} marginBottom={1}>
          <Text color="cyan">you&gt; </Text>
          <Text>{text}</Text>
        </Box>
      );
    }
    
    if (msg.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: ToolCall[] = [];
      
      for (const part of msg.content) {
        if (part.type === "text") {
          textParts.push(part.text);
        } else if (part.type === "toolCall") {
          toolCalls.push(part);
        }
      }
      
      return (
        <Box key={i} flexDirection="column" marginBottom={1}>
          {textParts.length > 0 && (
            <Box>
              <Text color="green">agent&gt; </Text>
              <Text>{textParts.join("")}</Text>
            </Box>
          )}
          {toolCalls.map((tc, j) => (
            <Box key={j} marginLeft={2}>
              <Text color="yellow">[{tc.name}]</Text>
              <Text color="gray"> {JSON.stringify(tc.arguments).slice(0, 60)}...</Text>
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
      const preview = text.length > 200 ? text.slice(0, 200) + "..." : text;
      return (
        <Box key={i} marginBottom={1} marginLeft={2}>
          <Text color={msg.isError ? "red" : "gray"}>└─ {preview}</Text>
        </Box>
      );
    }
    
    return null;
  };

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text color="cyan" bold>AgentBox</Text>
        <Text color="gray"> • </Text>
        <Text color="green">{agent.state.model.id}</Text>
        {context.files.length > 0 && (
          <>
            <Text color="gray"> • </Text>
            <Text color="gray">{context.files.join(", ")}</Text>
          </>
        )}
      </Box>

      {/* Messages */}
      {messages.map(renderMessage)}

      {/* Streaming response */}
      {state === "responding" && streamText && (
        <Box marginBottom={1}>
          <Text color="green">agent&gt; </Text>
          <Text>{streamText}</Text>
          <Text color="gray">▌</Text>
        </Box>
      )}

      {/* Error */}
      {error && (
        <Box marginBottom={1}>
          <Text color="red">Error: {error}</Text>
        </Box>
      )}

      {/* Input */}
      {state === "ready" && (
        <Box>
          <Text color="cyan">you&gt; </Text>
          <TextInput value={input} onChange={setInput} onSubmit={handleSubmit} />
        </Box>
      )}

      {state === "responding" && (
        <Box>
          <Text color="gray">... (Ctrl+C to abort)</Text>
        </Box>
      )}
    </Box>
  );
}

async function main() {
  // Check credentials
  const hasAuth = await hasCredentials("anthropic");
  if (!hasAuth) {
    console.log("No Anthropic credentials found.");
    console.log("Run 'claude' CLI first to authenticate, or we'll try to load from Claude Code.");
    
    // Try to login
    const success = await login("anthropic");
    if (!success) {
      console.error("✗ Could not authenticate. Run 'claude' first.");
      process.exit(1);
    }
    console.log("✓ Authenticated successfully");
  }

  // Load workspace context
  const context = await loadWorkspaceContext(process.cwd());

  // Create agent with system prompt
  const agent = createAgent(context.systemPrompt);

  // Render
  render(<App agent={agent} context={context} />);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
