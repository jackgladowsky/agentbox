import { readFile, access } from "fs/promises";
import { join } from "path";

// Files to load as context (in order of priority)
const CONTEXT_FILES = [
  "AGENTS.md",
  "SOUL.md", 
  "IDENTITY.md",
  "USER.md",
  "TOOLS.md",
];

export interface WorkspaceContext {
  systemPrompt: string;
  files: string[];
}

/**
 * Load workspace context files and build system prompt
 */
export async function loadWorkspaceContext(workspaceDir: string): Promise<WorkspaceContext> {
  const loaded: { name: string; content: string }[] = [];

  for (const file of CONTEXT_FILES) {
    const filePath = join(workspaceDir, file);
    try {
      await access(filePath);
      const content = await readFile(filePath, "utf-8");
      if (content.trim()) {
        loaded.push({ name: file, content: content.trim() });
      }
    } catch {
      // File doesn't exist, skip
    }
  }

  if (loaded.length === 0) {
    return { systemPrompt: "", files: [] };
  }

  // Build system prompt from workspace files
  const sections = loaded.map(({ name, content }) => {
    return `## ${name}\n${content}`;
  });

  const systemPrompt = `# Workspace Context

The following files define your identity and behavior:

${sections.join("\n\n")}
`;

  return {
    systemPrompt,
    files: loaded.map((f) => f.name),
  };
}
