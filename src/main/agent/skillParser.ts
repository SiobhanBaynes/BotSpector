import { isAbsolute, relative, resolve, sep } from 'path'

export interface Frontmatter {
  fields: Record<string, string>
  lists: Record<string, string[]>
}

export interface GitSpec {
  url: string
  ref?: string
  subdir?: string
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/g, '') || 'skill'
  )
}

function stripQuotes(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function parseInlineList(value: string): string[] {
  const inner = value.trim().replace(/^\[/, '').replace(/\]$/, '')
  if (!inner.trim()) return []
  return inner
    .split(',')
    .map((item) => stripQuotes(item))
    .filter((item) => item.length > 0)
}

export function parseFrontmatter(text: string): { front: Frontmatter; body: string } {
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
    const item = line.match(/^\s*-\s+(.*)$/)
    if (item && currentListKey) {
      lists[currentListKey].push(stripQuotes(item[1]))
      continue
    }

    const keyValue = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!keyValue) continue
    const key = keyValue[1].trim()
    const value = keyValue[2].trim()
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

  return { front: { fields, lists }, body: body.trim() }
}

export function parseGitSpec(spec: string): GitSpec {
  const trimmed = (spec ?? '').trim()
  if (!trimmed) throw new Error('Enter a Git repository URL.')

  const hashIndex = trimmed.indexOf('#')
  const url = (hashIndex === -1 ? trimmed : trimmed.slice(0, hashIndex)).trim()
  const rest = hashIndex === -1 ? '' : trimmed.slice(hashIndex + 1).trim()
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
      ref = rest.slice(0, colon).trim() || undefined
      subdir =
        rest
          .slice(colon + 1)
          .trim()
          .replace(/^\/+|\/+$/g, '') || undefined
    }
  }
  return { url, ref, subdir }
}

export function resolveGitSubdir(root: string, subdir?: string): string {
  if (!subdir) return root
  const candidate = resolve(root, subdir)
  const pathFromRoot = relative(root, candidate)
  if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new Error('Invalid subdirectory in the Git spec.')
  }
  return candidate
}

export function repoName(url: string): string {
  const trimmed = url.replace(/\/+$/g, '')
  const last = trimmed.split(/[/:]/).pop() ?? 'skill'
  return last.replace(/\.git$/i, '') || 'skill'
}
