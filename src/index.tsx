import React, { useState, useEffect } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import TextInput from "ink-text-input";
import { getClaudeCredentials, isExpired, type AuthToken } from "./credentials.js";
import { createClient, chat, type Message } from "./chat.js";
import { loadWorkspaceContext, type WorkspaceContext } from "./workspace.js";
import type Anthropic from "@anthropic-ai/sdk";

// App state
type AppState = "loading" | "ready" | "responding" | "error";

interface Props {
  auth: AuthToken;
  context: WorkspaceContext;
}

function App({ auth, context }: Props) {
  const { exit } = useApp();
  const [state, setState] = useState<AppState>("ready");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [response, setResponse] = useState("");
  const [error, setError] = useState<string | null>(null);

  const client = createClient(auth);

  const handleSubmit = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;

    // Commands
    if (trimmed === "/exit" || trimmed === "/quit") {
      exit();
      return;
    }
    if (trimmed === "/clear") {
      setMessages([]);
      setInput("");
      return;
    }

    // Add user message
    const newMessages: Message[] = [...messages, { role: "user", content: trimmed }];
    setMessages(newMessages);
    setInput("");
    setResponse("");
    setState("responding");

    try {
      const fullResponse = await chat(
        client,
        newMessages,
        { systemPrompt: context.systemPrompt },
        (delta) => setResponse((r) => r + delta)
      );
      setMessages([...newMessages, { role: "assistant", content: fullResponse }]);
      setState("ready");
    } catch (err) {
      setError(String(err));
      setState("error");
    }
  };

  // Handle Ctrl+C
  useInput((_, key) => {
    if (key.ctrl && key.return) {
      exit();
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text color="cyan" bold>AgentBox</Text>
        <Text color="gray"> • </Text>
        <Text color="green">{auth.subscriptionType}</Text>
        {context.files.length > 0 && (
          <>
            <Text color="gray"> • </Text>
            <Text color="gray">{context.files.join(", ")}</Text>
          </>
        )}
      </Box>

      {/* Messages */}
      {messages.map((msg, i) => (
        <Box key={i} marginBottom={1}>
          <Text color={msg.role === "user" ? "cyan" : "green"}>
            {msg.role === "user" ? "you" : "agent"}&gt;{" "}
          </Text>
          <Text>{msg.content}</Text>
        </Box>
      ))}

      {/* Streaming response */}
      {state === "responding" && response && (
        <Box marginBottom={1}>
          <Text color="green">agent&gt; </Text>
          <Text>{response}</Text>
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
          <Text color="gray">...</Text>
        </Box>
      )}
    </Box>
  );
}

async function main() {
  // Load credentials
  const auth = await getClaudeCredentials();
  if (!auth) {
    console.error("✗ No Claude Code credentials found. Run 'claude' first.");
    process.exit(1);
  }
  if (isExpired(auth)) {
    console.error("⚠ Credentials expired. Run 'claude' to refresh.");
    process.exit(1);
  }

  // Load workspace
  const context = await loadWorkspaceContext(process.cwd());

  // Render
  render(<App auth={auth} context={context} />);
}

main().catch(console.error);
