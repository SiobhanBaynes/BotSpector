import { createTwoFilesPatch } from 'diff'

export interface ResolutionFileVersion {
  path: string
  before: string
  after: string
}

const MAX_EVIDENCE_FILES = 20
const MAX_FILE_CHARS = 6000
const MAX_TOTAL_CHARS = 30000

function normalizedPath(path: string): string {
  return path.replace(/^\/+/, '')
}

export function buildResolutionEvidence(
  files: ResolutionFileVersion[],
  primaryPath: string | null
): string {
  const primary = primaryPath ? normalizedPath(primaryPath) : null
  const uniqueFiles = new Map<string, ResolutionFileVersion>()
  for (const file of files) {
    const path = normalizedPath(file.path)
    if (path && !uniqueFiles.has(path)) uniqueFiles.set(path, { ...file, path })
  }

  const ordered = [...uniqueFiles.values()]
    .filter((file) => file.before !== file.after)
    .sort((left, right) => {
      if (left.path === primary) return -1
      if (right.path === primary) return 1
      return left.path.localeCompare(right.path)
    })

  const sections: string[] = []
  let usedChars = 0
  for (const file of ordered.slice(0, MAX_EVIDENCE_FILES)) {
    const patch = createTwoFilesPatch(
      `a/${file.path}`,
      `b/${file.path}`,
      file.before,
      file.after,
      'base',
      'head',
      { context: 3 }
    )
    const section =
      patch.length > MAX_FILE_CHARS
        ? `${patch.slice(0, MAX_FILE_CHARS)}\n... (file diff truncated)`
        : patch
    if (usedChars + section.length > MAX_TOTAL_CHARS) break
    sections.push(section)
    usedChars += section.length
  }

  if (sections.length < ordered.length) {
    sections.push(`... (${ordered.length - sections.length} changed file diff(s) omitted)`)
  }
  return sections.join('\n\n')
}
