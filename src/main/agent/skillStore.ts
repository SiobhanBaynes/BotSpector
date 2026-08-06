import { app } from 'electron'
import { execFile } from 'child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { promisify } from 'util'
import type { Skill } from '../../shared/types'
import { logger } from '../logger'

const execFileAsync = promisify(execFile)

// External ("user") skills are Anthropic-style SKILL.md folders imported from
// disk. Each lives under <userData>/skills/user/<slug>/SKILL.md. We only ever
// read the SKILL.md markdown — never any scripts or binaries a skill folder
// might contain — because a skill's body is untrusted prompt content that runs
// against a model with tool access.

const SKILL_FILE = 'SKILL.md'

export function userSkillsDir(): string {
  const dir = join(app.getPath('userData'), 'skills', 'user')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

// Turn an arbitrary name into a filesystem- and id-safe slug.
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'skill'
  )
}

// ---- minimal YAML frontmatter parser ----
//
// Deliberately tiny: we only support the small, flat schema our skills use
// (scalar strings and simple string lists, block or inline). This avoids a
// YAML dependency and, more importantly, avoids executing anything.

interface Frontmatter {
  fields: Record<string, string>
  lists: Record<string, string[]>
}

function stripQuotes(v: string): string {
  const t = v.trim()
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1)
  }
  return t
}

function parseInlineList(v: string): string[] {
  // e.g. ["**/*.tsx", "**/*.css"]  or  [a, b]
  const inner = v.trim().replace(/^\[/, '').replace(/\]$/, '')
  if (!inner.trim()) return []
  return inner
    .split(',')
    .map((s) => stripQuotes(s))
    .filter((s) => s.length > 0)
}

function parseFrontmatter(text: string): { front: Frontmatter; body: string } {
  const normalized = text.replace(/\r\n/g, '\n')
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) {
    return { front: { fields: {}, lists: {} }, body: normalized.trim() }
  }
  const [, rawFront, body] = match
  const fields: Record<string, string> = {}
  const lists: Record<string, string[]> = {}

  const lines = rawFront.split('\n')
  let currentListKey: string | null = null
  for (const line of lines) {
    if (!line.trim()) continue
    // Block-list item: "  - value"
    const item = line.match(/^\s*-\s+(.*)$/)
    if (item && currentListKey) {
      lists[currentListKey].push(stripQuotes(item[1]))
      continue
    }
    // "key: value" (value may be empty to start a block list)
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (kv) {
      const key = kv[1].trim()
      const value = kv[2].trim()
      if (!value) {
        currentListKey = key
        lists[key] = lists[key] ?? []
      } else if (value.startsWith('[')) {
        currentListKey = null
        lists[key] = parseInlineList(value)
      } else {
        currentListKey = null
        fields[key] = stripQuotes(value)
      }
    }
  }
  return { front: { fields, lists }, body: body.trim() }
}

// Parse a SKILL.md into a Skill. Returns null if it lacks the essentials.
function parseSkillFile(dir: string, id: string): Skill | null {
  const file = join(dir, SKILL_FILE)
  if (!existsSync(file)) return null
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    logger.warn(`skillStore: could not read ${file}`, { error: (e as Error).message })
    return null
  }
  const { front, body } = parseFrontmatter(text)
  const name = front.fields.name?.trim() || id
  const description = front.fields.description?.trim() || 'Imported skill.'
  const instructions = body.trim()
  if (!instructions) {
    logger.warn(`skillStore: skill "${id}" has an empty body; skipping`)
    return null
  }
  const filePatterns = front.lists['file-patterns'] ?? front.lists['filePatterns']
  const toolAllowlist = front.lists['allowed-tools'] ?? front.lists['toolAllowlist']
  return {
    id,
    name,
    description,
    instructions,
    filePatterns: filePatterns && filePatterns.length > 0 ? filePatterns : undefined,
    toolAllowlist: toolAllowlist && toolAllowlist.length > 0 ? toolAllowlist : undefined,
    source: 'user',
    path: dir,
    version: front.fields.version?.trim() || undefined,
    isBuiltIn: false
  }
}

// List all imported user skills, parsed fresh from disk each call so edits and
// imports are picked up without a restart.
export function listUserSkills(): Skill[] {
  const root = userSkillsDir()
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return []
  }
  const skills: Skill[] = []
  for (const entry of entries) {
    const dir = join(root, entry)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    const skill = parseSkillFile(dir, entry)
    if (skill) skills.push(skill)
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

// Import a skill from a source folder the user picked. We copy ONLY the
// SKILL.md file (not scripts/binaries) into our managed store, so importing a
// skill can never bring executable code along with it.
export function importSkillFromFolder(sourceDir: string): Skill {
  let sourceFile = join(sourceDir, SKILL_FILE)
  if (!existsSync(sourceFile)) {
    // Allow the user to point directly at a SKILL.md as well.
    if (basename(sourceDir).toLowerCase() === SKILL_FILE.toLowerCase() && existsSync(sourceDir)) {
      sourceFile = sourceDir
    } else {
      throw new Error(`No ${SKILL_FILE} found in the selected folder.`)
    }
  }
  return storeSkillFromFile(sourceFile, basename(sourceDir))
}

// Import a skill from a Git repository. The spec accepts a plain URL, or
// "<url>#<ref>" to pin a branch/tag/commit, or "<url>#<ref>:<subdir>" to select
// one skill out of a monorepo (e.g. an Anthropic skills repo). We shallow-clone
// into a temp dir, copy ONLY the SKILL.md into our managed store, then delete
// the clone — no scripts or hooks from the repo are ever executed.
export async function importSkillFromGit(spec: string): Promise<Skill> {
  const parsed = parseGitSpec(spec)
  const tmp = mkdtempSync(join(tmpdir(), 'botspector-skill-'))
  try {
    const cloneArgs = ['clone', '--depth', '1']
    if (parsed.ref) cloneArgs.push('--branch', parsed.ref)
    cloneArgs.push('--', parsed.url, tmp)
    try {
      await execFileAsync('git', cloneArgs, { timeout: 60_000 })
    } catch (e) {
      // A shallow --branch clone only works for branch/tag names, not raw commit
      // SHAs. Surface the failure rather than silently pulling the wrong ref.
      throw new Error(`git clone failed: ${(e as Error).message.split('\n')[0]}`)
    }

    const skillDir = parsed.subdir ? join(tmp, parsed.subdir) : tmp
    // Guard against path traversal in the subdir (e.g. "../etc").
    if (!skillDir.startsWith(tmp)) {
      throw new Error('Invalid subdirectory in the Git spec.')
    }
    const sourceFile = join(skillDir, SKILL_FILE)
    if (!existsSync(sourceFile)) {
      throw new Error(
        `No ${SKILL_FILE} found${parsed.subdir ? ` at "${parsed.subdir}"` : ''} in the repository.`
      )
    }
    const fallbackName = parsed.subdir ? basename(parsed.subdir) : repoName(parsed.url)
    return storeSkillFromFile(sourceFile, fallbackName)
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true })
    } catch {
      // ignore temp cleanup failure
    }
  }
}

interface GitSpec {
  url: string
  ref?: string
  subdir?: string
}

function parseGitSpec(spec: string): GitSpec {
  const trimmed = (spec ?? '').trim()
  if (!trimmed) throw new Error('Enter a Git repository URL.')
  const hashIndex = trimmed.indexOf('#')
  const url = hashIndex === -1 ? trimmed : trimmed.slice(0, hashIndex)
  const rest = hashIndex === -1 ? '' : trimmed.slice(hashIndex + 1)
  // Only allow https/ssh git URLs — no local file:// paths or shell-ish input.
  if (!/^(https?:\/\/|git@|ssh:\/\/)/.test(url)) {
    throw new Error('Only https:// or ssh git URLs are supported.')
  }
  let ref: string | undefined
  let subdir: string | undefined
  if (rest) {
    const colon = rest.indexOf(':')
    if (colon === -1) {
      ref = rest
    } else {
      ref = rest.slice(0, colon) || undefined
      subdir = rest.slice(colon + 1).replace(/^\/+|\/+$/g, '') || undefined
    }
  }
  return { url, ref, subdir }
}

function repoName(url: string): string {
  const last = url.split('/').pop() ?? 'skill'
  return last.replace(/\.git$/i, '') || 'skill'
}

// Shared store step: parse the SKILL.md at sourceFile, allocate a unique slug,
// and copy ONLY that file into the managed store. Rolls back on parse failure.
function storeSkillFromFile(sourceFile: string, fallbackName: string): Skill {
  const text = readFileSync(sourceFile, 'utf8')
  const { front, body } = parseFrontmatter(text)
  if (!body.trim()) {
    throw new Error(`${SKILL_FILE} has no instruction body.`)
  }
  const name = front.fields.name?.trim() || fallbackName

  // Avoid clobbering an existing skill with the same slug.
  const root = userSkillsDir()
  let slug = slugify(name)
  let dir = join(root, slug)
  let n = 2
  while (existsSync(dir)) {
    slug = `${slugify(name)}-${n++}`
    dir = join(root, slug)
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, SKILL_FILE), text, 'utf8')

  const skill = parseSkillFile(dir, slug)
  if (!skill) {
    // Roll back a bad import so we don't leave a broken folder behind.
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
    throw new Error('The selected skill could not be parsed.')
  }
  logger.info(`skillStore: imported skill "${skill.id}" (${skill.name})`)
  return skill
}

// Remove an imported skill by id. Only user skills live here, so this can never
// delete a built-in.
export function removeUserSkill(id: string): void {
  const dir = join(userSkillsDir(), id)
  if (!existsSync(dir)) return
  rmSync(dir, { recursive: true, force: true })
  logger.info(`skillStore: removed skill "${id}"`)
}
