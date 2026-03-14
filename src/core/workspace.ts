import { readFile } from "fs/promises";
import { join } from "path";
import { getAgentName, agentDir } from "./config.js";

export interface WorkspaceContext {
  systemPrompt: string;
  agentName: string;
}

export async function loadWorkspaceContext(): Promise<WorkspaceContext> {
  const agentName = getAgentName();
  const systemPath = join(agentDir(agentName), "system.md");
  const systemPrompt = await readFile(systemPath, "utf-8");
  return { systemPrompt, agentName };
}
