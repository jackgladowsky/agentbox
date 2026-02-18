import { execSync } from 'child_process'
import { readdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'

export interface SkillCLI {
  type: 'prebuilt' | 'custom'
  binary: string
  install: {
    method: string
    command: string
  }
}

export interface SkillAuth {
  required: boolean
  method: string
  env_vars: string[]
  notes: string
}

export interface SkillCommand {
  description: string
  usage: string
}

export interface Skill {
  name: string
  description: string
  version: string
  cli: SkillCLI
  auth: SkillAuth
  depends_on: string[]
  commands: Record<string, SkillCommand>
  status: 'installed' | 'not_installed' | 'needs_auth'
}

const SKILLS_DIR = join(process.cwd(), 'skills')

function isInstalled(binary: string): boolean {
  try {
    execSync(`which ${binary}`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function isAuthed(skill: Skill): boolean {
  if (!skill.auth.required) return true
  return skill.auth.env_vars.every(v => !!process.env[v])
}

export function loadSkills(): Skill[] {
  if (!existsSync(SKILLS_DIR)) return []

  const skills: Skill[] = []

  for (const dir of readdirSync(SKILLS_DIR)) {
    const skillPath = join(SKILLS_DIR, dir, 'skill.json')
    if (!existsSync(skillPath)) continue

    const skill: Skill = JSON.parse(readFileSync(skillPath, 'utf-8'))

    // Resolve actual status at runtime
    if (!isInstalled(skill.cli.binary)) {
      skill.status = 'not_installed'
    } else if (!isAuthed(skill)) {
      skill.status = 'needs_auth'
    } else {
      skill.status = 'installed'
    }

    skills.push(skill)
  }

  return skills
}

export function getSkill(name: string): Skill | undefined {
  return loadSkills().find(s => s.name === name)
}

export function skillsStatus(): string {
  const skills = loadSkills()
  const lines = skills.map(s => {
    const icon = s.status === 'installed' ? '✅' : s.status === 'needs_auth' ? '🔑' : '❌'
    return `${icon} ${s.name} — ${s.description}`
  })
  return lines.join('\n')
}

export function skillsSummary(): object {
  return loadSkills().map(s => ({
    name: s.name,
    status: s.status,
    binary: s.cli.binary,
    auth_required: s.auth.required,
    depends_on: s.depends_on,
    commands: Object.keys(s.commands),
  }))
}
