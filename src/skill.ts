#!/usr/bin/env node
/**
 * skill — AgentBox skill manager CLI
 *
 * Manages skills in the skills/ directory relative to the agentbox repo root.
 * Works for any agent running on any machine — no hardcoded paths.
 */

import fs from 'fs';
import path from 'path';
import { execSync, spawnSync } from 'child_process';
import readline from 'readline';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Paths — relative to this file, works wherever agentbox is cloned
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SKILLS_DIR = path.join(REPO_ROOT, 'skills');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Skill {
  name: string;
  description: string;
  cliType: 'prebuilt' | 'custom';
  binary: string;
  installCmd: string | null;
  repo: string | null;
  authRequired: 'yes' | 'no' | 'optional';
  envVars: string[];
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function parseSkillMd(filePath: string): Skill {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n');

  const name = (lines.find(l => l.startsWith('# ')) ?? '').replace(/^# /, '').trim();
  const descIdx = lines.findIndex(l => l.startsWith('# '));
  const description = descIdx >= 0 ? (lines[descIdx + 2] ?? '').trim() : '';

  const get = (label: string): string | null => {
    const pattern = new RegExp(`^-\\s+\\*\\*${label}:\\*\\*\\s*\`?([^\`\\n]+)\`?`);
    for (const line of lines) {
      const m = line.match(pattern);
      if (m) return m[1].trim();
    }
    return null;
  };

  const rawType = get('Type') ?? 'prebuilt';
  const cliType: 'prebuilt' | 'custom' = rawType === 'custom' ? 'custom' : 'prebuilt';

  const binary = get('Binary') ?? name;
  const installCmd = get('Install');
  const repo = get('Repo');

  const rawAuth = (get('Required') ?? 'no').toLowerCase();
  let authRequired: 'yes' | 'no' | 'optional' = 'no';
  if (rawAuth === 'yes') authRequired = 'yes';
  else if (rawAuth.startsWith('only') || rawAuth.startsWith('optional')) authRequired = 'optional';

  const envVars: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*-\s+\*\*Env:\*\*\s+`?([^`\n]+)`?/);
    if (m) {
      m[1].split(',').forEach(v => {
        const trimmed = v.trim().replace(/`/g, '');
        if (trimmed) envVars.push(trimmed);
      });
    }
  }

  return { name, description, cliType, binary, installCmd, repo, authRequired, envVars };
}

function loadAllSkills(): Skill[] {
  if (!fs.existsSync(SKILLS_DIR)) {
    console.error(`Skills directory not found: ${SKILLS_DIR}`);
    process.exit(1);
  }
  return fs.readdirSync(SKILLS_DIR)
    .filter(d => {
      const p = path.join(SKILLS_DIR, d);
      return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'skill.md'));
    })
    .map(d => parseSkillMd(path.join(SKILLS_DIR, d, 'skill.md')))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isInstalled(binary: string): boolean {
  // 1. Try PATH lookup via `which`
  if (spawnSync('which', [binary], { encoding: 'utf8' }).status === 0) return true;

  // 2. If it looks like an absolute path, check existence directly
  if (path.isAbsolute(binary)) {
    try { fs.accessSync(binary, fs.constants.X_OK); return true; } catch { /* not found */ }
  }

  // 3. Resolve relative paths (e.g. ./node_modules/.bin/foo) against repo root
  const resolved = path.resolve(REPO_ROOT, binary);
  try { fs.accessSync(resolved, fs.constants.X_OK); return true; } catch { /* not found */ }

  return false;
}

function authLabel(skill: Skill): string {
  if (skill.authRequired === 'yes') return 'auth req ';
  if (skill.authRequired === 'optional') return 'opt auth ';
  return 'no auth  ';
}

function missingEnvVars(skill: Skill): string[] {
  return skill.envVars.filter(v => !process.env[v]);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdList(): void {
  const skills = loadAllSkills();
  for (const s of skills) {
    const installed = isInstalled(s.binary);
    const icon = installed ? '✅' : '❌';
    const suffix = installed ? '' : '  (not installed)';
    console.log(`${icon} ${s.name.padEnd(12)} ${s.cliType.padEnd(9)} ${authLabel(s)} ${s.binary}${suffix}`);
  }
}

function cmdStatus(): void {
  const skills = loadAllSkills();
  for (const s of skills) {
    const installed = isInstalled(s.binary);
    const missing = missingEnvVars(s);
    const authStatus = s.authRequired === 'yes'
      ? (missing.length > 0 ? `needs auth (missing: ${missing.join(', ')})` : 'auth ok')
      : s.authRequired === 'optional' ? 'auth optional' : 'no auth';

    console.log(`${installed ? '✅' : '❌'} ${s.name}`);
    console.log(`   binary:  ${s.binary} [${installed ? 'installed' : 'NOT FOUND'}]`);
    console.log(`   auth:    ${authStatus}`);
    if (s.description) console.log(`   about:   ${s.description}`);
    console.log();
  }
}

function cmdCheck(): void {
  const skills = loadAllSkills();
  const installed: string[] = [];
  const missing: string[] = [];
  const needsAuth: string[] = [];

  for (const s of skills) {
    if (isInstalled(s.binary)) installed.push(s.name);
    else missing.push(s.name);

    if (s.authRequired === 'yes' && missingEnvVars(s).length > 0) {
      needsAuth.push(`${s.name} (${missingEnvVars(s).join(', ')} not set)`);
    }
  }

  console.log(`Installed:   ${installed.length ? installed.join(', ') : 'none'}`);
  console.log(`Missing:     ${missing.length ? missing.join(', ') : 'none'}`);
  console.log(`Needs auth:  ${needsAuth.length ? needsAuth.join(', ') : 'none'}`);
}

function cmdShow(name: string): void {
  const skillPath = path.join(SKILLS_DIR, name, 'skill.md');
  if (!fs.existsSync(skillPath)) {
    console.error(`No skill found: ${name}`);
    process.exit(1);
  }
  console.log(fs.readFileSync(skillPath, 'utf8'));
}

async function cmdInstall(name: string): Promise<void> {
  const skillPath = path.join(SKILLS_DIR, name, 'skill.md');
  if (!fs.existsSync(skillPath)) {
    console.error(`No skill found: ${name}`);
    process.exit(1);
  }
  const skill = parseSkillMd(skillPath);

  if (!skill.installCmd) {
    console.error(`No install command defined for: ${name}`);
    process.exit(1);
  }

  console.log(`Install command for ${skill.name}:\n  ${skill.installCmd}\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>(resolve => rl.question('Run this? [y/N] ', resolve));
  rl.close();

  if (answer.trim().toLowerCase() !== 'y') { console.log('Aborted.'); return; }

  console.log(`\nRunning: ${skill.installCmd}\n`);
  try {
    execSync(skill.installCmd, { stdio: 'inherit', shell: '/bin/bash' });
  } catch {
    console.error('\nInstall command failed.');
    process.exit(1);
  }

  console.log(isInstalled(skill.binary)
    ? `\n✅ ${skill.binary} is now available.`
    : `\n⚠️  Command ran but '${skill.binary}' still not found in PATH.`
  );
}

function cmdAdd(name: string): void {
  const skillDir = path.join(SKILLS_DIR, name);
  const skillPath = path.join(skillDir, 'skill.md');

  if (fs.existsSync(skillPath)) {
    console.error(`Skill already exists: ${name}`);
    process.exit(1);
  }

  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(skillPath, `# ${name}

Short description.

## CLI
- **Type:** prebuilt
- **Binary:** \`${name}\`
- **Install:** \`sudo apt install ${name}\`

## Auth
- **Required:** no

## Depends On
- none

## Commands
- \`${name} --help\`
`, 'utf8');

  console.log(`Created: ${skillPath}`);
  console.log('Edit the file to fill in the details.');
}

function printHelp(): void {
  console.log(`skill — AgentBox skill manager

Usage:
  skill list               List all skills with status
  skill status             Verbose skill status
  skill check              Installed vs missing vs needs-auth summary
  skill show <name>        Print the full skill.md for a skill
  skill install <name>     Run the install command for a skill
  skill add <name>         Scaffold a new skill from template
  skill help               Show this help
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const [,, cmd, ...args] = process.argv;

switch (cmd) {
  case 'list':     cmdList(); break;
  case 'status':   cmdStatus(); break;
  case 'check':    cmdCheck(); break;
  case 'show':
    if (!args[0]) { console.error('Usage: skill show <name>'); process.exit(1); }
    cmdShow(args[0]);
    break;
  case 'install':
    if (!args[0]) { console.error('Usage: skill install <name>'); process.exit(1); }
    cmdInstall(args[0]);
    break;
  case 'add':
    if (!args[0]) { console.error('Usage: skill add <name>'); process.exit(1); }
    cmdAdd(args[0]);
    break;
  case 'help': case '--help': case '-h': case undefined:
    printHelp();
    break;
  default:
    console.error(`Unknown command: ${cmd}`);
    printHelp();
    process.exit(1);
}
