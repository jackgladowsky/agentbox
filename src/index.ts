import * as readline from "readline";
import { getClaudeCredentials, isExpired } from "./credentials.js";
import { createClient, chat, type Message } from "./chat.js";
import { loadWorkspaceContext } from "./workspace.js";

const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
};

async function main() {
  console.log(`${COLORS.cyan}╭──────────────────────────────────────╮${COLORS.reset}`);
  console.log(`${COLORS.cyan}│${COLORS.reset}            ${COLORS.green}AgentBox${COLORS.reset}                 ${COLORS.cyan}│${COLORS.reset}`);
  console.log(`${COLORS.cyan}│${COLORS.reset}   ${COLORS.dim}Your AI, your hardware, your rules${COLORS.reset}  ${COLORS.cyan}│${COLORS.reset}`);
  console.log(`${COLORS.cyan}╰──────────────────────────────────────╯${COLORS.reset}`);
  console.log();

  // Load Claude Code credentials
  const auth = await getClaudeCredentials();
  if (!auth) {
    console.error(`${COLORS.red}✗ No Claude Code credentials found.${COLORS.reset}`);
    console.error(`  Run 'claude' and authenticate first.`);
    process.exit(1);
  }

  if (isExpired(auth)) {
    console.error(`${COLORS.yellow}⚠ Claude Code credentials expired.${COLORS.reset}`);
    console.error(`  Run 'claude' to refresh.`);
    process.exit(1);
  }

  console.log(`${COLORS.green}✓${COLORS.reset} Authenticated (${auth.subscriptionType})`);

  // Load workspace context
  const workspaceDir = process.cwd();
  const context = await loadWorkspaceContext(workspaceDir);
  if (context.files.length > 0) {
    console.log(`${COLORS.green}✓${COLORS.reset} Loaded workspace: ${context.files.join(", ")}`);
  }
  console.log();

  // Create client
  const client = createClient(auth);
  const messages: Message[] = [];

  // Start REPL
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = () => {
    rl.question(`${COLORS.cyan}you>${COLORS.reset} `, async (input) => {
      const trimmed = input.trim();
      
      if (!trimmed) {
        prompt();
        return;
      }

      if (trimmed === "/exit" || trimmed === "/quit") {
        console.log(`${COLORS.dim}Goodbye.${COLORS.reset}`);
        rl.close();
        process.exit(0);
      }

      if (trimmed === "/clear") {
        messages.length = 0;
        console.log(`${COLORS.dim}Conversation cleared.${COLORS.reset}`);
        prompt();
        return;
      }

      messages.push({ role: "user", content: trimmed });

      process.stdout.write(`${COLORS.green}agent>${COLORS.reset} `);

      try {
        const response = await chat(
          client,
          messages,
          { systemPrompt: context.systemPrompt },
          (delta) => process.stdout.write(delta)
        );
        console.log("\n");

        messages.push({ role: "assistant", content: response });
      } catch (err) {
        console.error(`\n${COLORS.red}Error: ${err}${COLORS.reset}\n`);
      }

      prompt();
    });
  };

  console.log(`${COLORS.dim}Commands: /exit, /clear${COLORS.reset}`);
  console.log();
  prompt();
}

main().catch(console.error);
