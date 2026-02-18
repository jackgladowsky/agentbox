import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import TextInput from "ink-text-input";
import { Agent, type AgentEvent, type AgentMessage } from "@mariozechner/pi-agent-core";
import { type TextContent, type ThinkingContent, type ToolCall } from "@mariozechner/pi-ai";
import { createAgent, DEFAULT_MODEL } from "./agent.js";
import { hasCredentials, login } from "./auth.js";
import { loadWorkspaceContext, type WorkspaceContext } from "./workspace.js";

type AppState = "ready" | "responding" | "error";

interface ChatHistory {
  messages: AgentMessage[];
  streamingText: string;
  isStreaming: boolean;
}

interface Props {
  agent: Agent;
  context: WorkspaceContext;
}

function App({ agent, context }: Props) {
  const { exit } = useApp();
  const [state, setState] = useState<AppState>("ready");
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<ChatHistory>({
    messages: [],
    streamingText: "",
    isStreaming: false
  });
  
  // Refs to prevent excessive re-renders
  const streamingTextRef = useRef("");
  const updateTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Subscribe to agent events
  useEffect(() => {
    const unsubscribe = agent.subscribe((event: AgentEvent) => {
      switch (event.type) {
        case "agent_start":
          setState("responding");
          streamingTextRef.current = "";
          setHistory(prev => ({
            ...prev,
            streamingText: "",
            isStreaming: true
          }));
          break;
          
        case "message_update":
          // Throttle streaming updates to prevent flickering
          if (event.message.role === "assistant") {
            const textParts = event.message.content
              .filter((c): c is TextContent => c.type === "text")
              .map((c) => c.text);
            streamingTextRef.current = textParts.join("");
            
            // Debounce UI updates
            if (updateTimeoutRef.current) {
              clearTimeout(updateTimeoutRef.current);
            }
            updateTimeoutRef.current = setTimeout(() => {
              setHistory(prev => ({
                ...prev,
                streamingText: streamingTextRef.current
              }));
            }, 50); // Update every 50ms instead of every character
          }
          break;
          
        case "agent_end":
          if (updateTimeoutRef.current) {
            clearTimeout(updateTimeoutRef.current);
          }
          setHistory(prev => ({
            messages: [...event.messages],
            streamingText: "",
            isStreaming: false
          }));
          setState("ready");
          break;
          
        case "tool_execution_start":
          // Show tool execution without excessive updates
          const toolText = `\n[${event.toolName}] executing...`;
          streamingTextRef.current += toolText;
          setHistory(prev => ({
            ...prev,
            streamingText: streamingTextRef.current
          }));
          break;
      }
    });

    return () => {
      unsubscribe();
      if (updateTimeoutRef.current) {
        clearTimeout(updateTimeoutRef.current);
      }
    };
  }, [agent]);

  const handleSubmit = useCallback(async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;

    // Clear any error state
    setError(null);

    // Handle commands
    if (trimmed === "/exit" || trimmed === "/quit") {
      exit();
      return;
    }
    
    if (trimmed === "/clear") {
      agent.clearMessages();
      setHistory({
        messages: [],
        streamingText: "",
        isStreaming: false
      });
      setInput("");
      return;
    }
    
    if (trimmed.startsWith("/model ")) {
      const modelId = trimmed.slice(7).trim();
      try {
        agent.setModel({ ...DEFAULT_MODEL, id: modelId });
        console.log(`✓ Switched to model: ${modelId}`);
      } catch (err) {
        setError(`Invalid model: ${modelId}`);
      }
      setInput("");
      return;
    }
    
    if (trimmed === "/thinking on") {
      agent.setThinkingLevel("medium");
      console.log("✓ Thinking enabled");
      setInput("");
      return;
    }
    
    if (trimmed === "/thinking off") {
      agent.setThinkingLevel("off");
      console.log("✓ Thinking disabled");
      setInput("");
      return;
    }

    if (trimmed === "/help") {
      console.log("Commands:");
      console.log("  /model <id>    - Switch model (e.g., /model claude-opus-4-6)");
      console.log("  /thinking on   - Enable thinking mode");
      console.log("  /thinking off  - Disable thinking mode");
      console.log("  /clear         - Clear conversation");
      console.log("  /exit          - Exit AgentBox");
      console.log("  /help          - Show this help");
      setInput("");
      return;
    }

    // Clear input and send prompt
    setInput("");
    
    try {
      await agent.prompt(trimmed);
    } catch (err) {
      setError(String(err));
      setState("error");
    }
  }, [agent, exit]);

  // Handle Ctrl+C for abort/exit
  useInput((_, key) => {
    if (key.ctrl && key.return) {
      if (state === "responding") {
        agent.abort();
        console.log("\n⚠️  Aborted");
      } else {
        exit();
      }
    }
  });

  // Memoize message rendering to prevent unnecessary re-renders
  const renderedMessages = useMemo(() => {
    return history.messages.map((msg, i) => {
      const key = `msg-${i}-${msg.role}`;
      
      if (msg.role === "user") {
        const text = typeof msg.content === "string" 
          ? msg.content 
          : msg.content.filter((c): c is TextContent => c.type === "text").map(c => c.text).join("");
        return (
          <Box key={key} marginY={0}>
            <Text color="cyan" bold>you&gt;</Text>
            <Text> {text}</Text>
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
          <Box key={key} flexDirection="column" marginY={0}>
            {textParts.length > 0 && (
              <Box>
                <Text color="green" bold>agent&gt;</Text>
                <Text> {textParts.join("")}</Text>
              </Box>
            )}
            {toolCalls.map((tc, j) => (
              <Box key={`${key}-tool-${j}`} marginLeft={2}>
                <Text color="yellow" bold>[{tc.name}]</Text>
                <Text color="gray"> {JSON.stringify(tc.arguments).slice(0, 80)}...</Text>
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
        const preview = text.length > 150 ? text.slice(0, 150) + "..." : text;
        return (
          <Box key={key} marginLeft={2} marginY={0}>
            <Text color={msg.isError ? "red" : "gray"}>└─ {preview}</Text>
          </Box>
        );
      }
      
      return null;
    }).filter(Boolean);
  }, [history.messages]);

  // Status line
  const statusLine = useMemo(() => {
    const modelName = agent.state.model.id;
    const files = context.files.length > 0 ? ` • ${context.files.join(", ")}` : "";
    return `AgentBox • ${modelName}${files}`;
  }, [agent.state.model.id, context.files]);

  return (
    <Box flexDirection="column" minHeight={24}>
      {/* Clean header */}
      <Box borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1}>
        <Text color="cyan" bold>{statusLine}</Text>
      </Box>

      {/* Message history - stable rendering */}
      <Box flexDirection="column" flexGrow={1}>
        {renderedMessages}
        
        {/* Streaming response - only render when actually streaming */}
        {history.isStreaming && history.streamingText && (
          <Box marginY={0}>
            <Text color="green" bold>agent&gt;</Text>
            <Text> {history.streamingText}</Text>
            <Text color="gray">▌</Text>
          </Box>
        )}
      </Box>

      {/* Error display */}
      {error && (
        <Box marginY={1} borderStyle="round" borderColor="red" paddingX={1}>
          <Text color="red">✗ {error}</Text>
        </Box>
      )}

      {/* Input area - always at bottom */}
      <Box borderStyle="round" borderColor="gray" paddingX={1} marginTop={1}>
        {state === "ready" ? (
          <Box>
            <Text color="cyan" bold>you&gt;</Text>
            <Text> </Text>
            <TextInput 
              value={input} 
              onChange={setInput} 
              onSubmit={handleSubmit}
              placeholder="Type your message... (/help for commands)"
            />
          </Box>
        ) : (
          <Box>
            <Text color="gray">Thinking... (Ctrl+Enter to abort)</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}

async function main() {
  // Check credentials
  const hasAuth = await hasCredentials("anthropic");
  if (!hasAuth) {
    console.log("🔑 No Anthropic credentials found.");
    console.log("Run 'claude' CLI first to authenticate, or we'll try to load from Claude Code.");
    
    const success = await login("anthropic");
    if (!success) {
      console.error("✗ Could not authenticate. Run 'claude' first.");
      process.exit(1);
    }
    console.log("✓ Authenticated successfully");
  }

  // Load workspace context
  console.log("🚀 Starting AgentBox...");
  const context = await loadWorkspaceContext(process.cwd());

  // Create agent
  const agent = createAgent(context.systemPrompt);
  console.log(`✓ Agent ready with ${agent.state.model.id}`);
  console.log("Type /help for commands\n");

  // Render clean UI
  render(<App agent={agent} context={context} />);
}

main().catch((err) => {
  console.error("💥 Fatal error:", err);
  process.exit(1);
});