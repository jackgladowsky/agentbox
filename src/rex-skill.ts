#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { execSync, spawnSync } from 'child_process';
import readline from 'readline';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const SKILLS_DIR = path.resolve(import.meta.dirname, '../../agentbox/skills');

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
  authMethod: string | null;
  envVars: string[];
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function parseSkillMd(filePath: string): Skill {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n');

  const name = (lines.find(l => l.startsWith('# ')) ?? '').replace(/^# /, '').trim();
  const descLine = lines.findIndex(l => l.startsWith('# '));
  const description = descLine >= 0 ? (lines[descLine + 2] ?? '').trim() : '';

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

  const authMethod = get('Method');

  // collect all env vars mentioned in **Env:** lines (may be comma-separated)
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

  return { name, description, cliType, binary, installCmd, repo, authRequired, authMethod, envVars };
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

function isBinaryInstalled(binary: string): boolean {
  const result = spawnSync('which', [binary], { encoding: 'utf8' });
  return result.status === 0;
}

function authLabel(skill: Skill): string {
  if (skill.authRequired === 'yes') return 'auth req  ';
  if (skill.authRequired === 'optional') return 'opt auth  ';
  return 'no auth   ';
}

function statusIcon(installed: boolean): string {
  return installed ? '✅' : '❌';
}

function envMissing(skill: Skill): string[] {
  return skill.envVars.filter(v => !process.env[v]);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdList(): void {
  const skills = loadAllSkills();
  for (const skill of skills) {
    const installed = isBinaryInstalled(skill.binary);
    const icon = statusIcon(installed);
    const auth = authLabel(skill);
    const type = skill.cliType.padEnd(8);
    const notInstalled = installed ? '' : '  (not installed)';
    console.log(`${icon} ${skill.name.padEnd(12)} ${type} ${auth} ${skill.binary}${notInstalled}`);
  }
}

function cmdStatus(): void {
  const skills = loadAllSkills();
  console.log('Skills status:\n');
  for (const skill of skills) {
    const installed = isBinaryInstalled(skill.binary);
    const icon = statusIcon(installed);
    const missing = envMissing(skill);
    const authStatus = skill.authRequired === 'yes'
      ? (missing.length > 0 ? `auth req (missing: ${missing.join(', ')})` : 'auth req (env set)')
      : skill.authRequired === 'optional'
      ? 'auth optional'
      : 'no auth';
    console.log(`${icon} ${skill.name}`);
    console.log(`   binary:  ${skill.binary} ${installed ? '[installed]' : '[NOT FOUND]'}`);
    console.log(`   auth:    ${authStatus}`);
    if (skill.description) console.log(`   about:   ${skill.description}`);
    console.log();
  }
}

function cmdShow(name: string): void {
  const skillPath = path.join(SKILLS_DIR, name, 'skill.md');
  if (!fs.existsSync(skillPath)) {
    console.error(`No skill found: ${name}`);
    process.exit(1);
  }
  console.log(fs.readFileSync(skillPath, 'utf8'));
}

function cmdCheck(): void {
  const skills = loadAllSkills();
  const installed: string[] = [];
  const missing: string[] = [];
  const needsAuth: string[] = [];

  for (const skill of skills) {
    if (isBinaryInstalled(skill.binary)) {
      installed.push(skill.name);
    } else {
      missing.push(skill.name);
    }
    if (skill.authRequired === 'yes' && envMissing(skill).length > 0) {
      const vars = envMissing(skill).join(', ');
      needsAuth.push(`${skill.name} (${vars} not set)`);
    }
  }

  console.log(`Installed:   ${installed.length > 0 ? installed.join(', ') : 'none'}`);
  console.log(`Missing:     ${missing.length > 0 ? missing.join(', ') : 'none'}`);
  console.log(`Needs auth:  ${needsAuth.length > 0 ? needsAuth.join(', ') : 'none'}`);
}

async function cmdInstall(name: string): Promise<void> {
  const skillPath = path.join(SKILLS_DIR, name, 'skill.md');
  if (!fs.existsSync(skillPath)) {
    console.error(`No skill found: ${name}`);
    process.exit(1);
  }
  const skill = parseSkillMd(skillPath);

  if (!skill.installCmd) {
    console.error(`No install command defined for skill: ${name}`);
    process.exit(1);
  }

  console.log(`Install command for ${skill.name}:`);
  console.log(`  ${skill.installCmd}`);
  console.log();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>(resolve => {
    rl.question('Run this command? [y/N] ', resolve);
  });
  rl.close();

  if (answer.trim().toLowerCase() !== 'y') {
    console.log('Aborted.');
    return;
  }

  console.log(`\nRunning: ${skill.installCmd}\n`);
  try {
    execSync(skill.installCmd, { stdio: 'inherit', shell: '/bin/bash' });
  } catch {
    console.error('\nInstall command failed.');
    process.exit(1);
  }

  const installed = isBinaryInstalled(skill.binary);
  if (installed) {
    console.log(`\n✅ ${skill.binary} is now available.`);
  } else {
    console.log(`\n⚠️  Command ran, but binary '${skill.binary}' still not found in PATH.`);
  }
}

function cmdAdd(name: string): void {
  const skillDir = path.join(SKILLS_DIR, name);
  const skillPath = path.join(skillDir, 'skill.md');

  if (fs.existsSync(skillPath)) {
    console.error(`Skill already exists: ${name}`);
    process.exit(1);
  }

  fs.mkdirSync(skillDir, { recursive: true });

  const template = `# ${name}

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
`;

  fs.writeFileSync(skillPath, template, 'utf8');
  console.log(`Created: ${skillPath}`);
  console.log('Edit the file to fill in the details.');
}

function printHelp(): void {
  console.log(`rex-skill — skill manager for agentbox

Usage:
  rex-skill list                 List all skills with status
  rex-skill status               Verbose skill status
  rex-skill show <name>          Print the full skill.md for a skill
  rex-skill install <name>       Run the install command for a skill
  rex-skill check                Check installed vs missing binaries
  rex-skill add <name>           Scaffold a new skill.md from template
  rex-skill help                 Show this help
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const [, , cmd, ...args] = process.argv;

switch (cmd) {
  case 'list':
    cmdList();
    break;
  case 'status':
    cmdStatus();
    break;
  case 'show':
    if (!args[0]) { console.error('Usage: rex-skill show <name>'); process.exit(1); }
    cmdShow(args[0]);
    break;
  case 'install':
    if (!args[0]) { console.error('Usage: rex-skill install <name>'); process.exit(1); }
    cmdInstall(args[0]);
    break;
  case 'check':
    cmdCheck();
    break;
  case 'add':
    if (!args[0]) { console.error('Usage: rex-skill add <name>'); process.exit(1); }
    cmdAdd(args[0]);
    break;
  case 'help':
  case '--help':
  case '-h':
  case undefined:
    printHelp();
    break;
  default:
    console.error(`Unknown command: ${cmd}`);
    printHelp();
    process.exit(1);
}
