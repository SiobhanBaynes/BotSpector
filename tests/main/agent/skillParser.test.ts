import { join, resolve } from 'path'
import { describe, expect, it } from 'vitest'
import {
  parseFrontmatter,
  parseGitSpec,
  repoName,
  resolveGitSubdir,
  slugify
} from '../../../src/main/agent/skillParser'

describe('slugify', () => {
  it.each([
    ['Security Review', 'security-review'],
    ['  UI and UX  ', 'ui-and-ux'],
    ['API / Backend: Review', 'api-backend-review'],
    ['already-a-slug', 'already-a-slug'],
    ['UPPER_case', 'upper-case']
  ])('converts %j to %j', (input, expected) => {
    expect(slugify(input)).toBe(expected)
  })

  it.each(['', '---', '   ', '£$%'])('uses a fallback for %j', (input) => {
    expect(slugify(input)).toBe('skill')
  })

  it('limits slugs to 60 characters', () => {
    expect(slugify('a'.repeat(80))).toBe('a'.repeat(60))
  })

  it('does not leave a trailing separator after truncation', () => {
    expect(slugify(`${'a'.repeat(59)} and more`)).toBe('a'.repeat(59))
  })
})

describe('parseFrontmatter', () => {
  it('parses scalar fields and trims the body', () => {
    const parsed = parseFrontmatter('---\nname: Security\ndescription: Finds issues\n---\n\nReview code.\n')

    expect(parsed).toEqual({
      front: {
        fields: { name: 'Security', description: 'Finds issues' },
        lists: {}
      },
      body: 'Review code.'
    })
  })

  it('removes matching single and double quotes from fields', () => {
    const parsed = parseFrontmatter('---\nname: "UI Review"\nversion: \'1.2\'\n---\nBody')

    expect(parsed.front.fields).toEqual({ name: 'UI Review', version: '1.2' })
  })

  it('keeps colons inside scalar values', () => {
    const parsed = parseFrontmatter('---\ndescription: Focus: auth and access\n---\nBody')

    expect(parsed.front.fields.description).toBe('Focus: auth and access')
  })

  it('parses quoted and unquoted inline list items', () => {
    const parsed = parseFrontmatter(
      '---\nfile-patterns: ["**/*.ts", \'**/*.tsx\', README.md]\n---\nBody'
    )

    expect(parsed.front.lists['file-patterns']).toEqual(['**/*.ts', '**/*.tsx', 'README.md'])
  })

  it('parses block lists', () => {
    const parsed = parseFrontmatter(
      '---\nallowed-tools:\n  - repo_file\n  - "search_code"\n---\nBody'
    )

    expect(parsed.front.lists['allowed-tools']).toEqual(['repo_file', 'search_code'])
  })

  it('parses multiple lists independently', () => {
    const parsed = parseFrontmatter(
      '---\nfile-patterns:\n  - "**/*.ts"\nallowed-tools:\n  - repo_file\n---\nBody'
    )

    expect(parsed.front.lists).toEqual({
      'file-patterns': ['**/*.ts'],
      'allowed-tools': ['repo_file']
    })
  })

  it('supports empty inline and block lists', () => {
    const parsed = parseFrontmatter('---\ninline: []\nblock:\n---\nBody')

    expect(parsed.front.lists).toEqual({ inline: [], block: [] })
  })

  it('normalizes CRLF line endings', () => {
    const parsed = parseFrontmatter('---\r\nname: Review\r\n---\r\nFirst\r\nSecond')

    expect(parsed.front.fields.name).toBe('Review')
    expect(parsed.body).toBe('First\nSecond')
  })

  it('returns plain Markdown without frontmatter as the body', () => {
    const parsed = parseFrontmatter('\n  Review these files.\n')

    expect(parsed).toEqual({
      front: { fields: {}, lists: {} },
      body: 'Review these files.'
    })
  })

  it('treats unclosed frontmatter as body text', () => {
    const text = '---\nname: Incomplete\nBody'

    expect(parseFrontmatter(text).body).toBe(text)
  })

  it('ignores unsupported frontmatter lines', () => {
    const parsed = parseFrontmatter('---\n# comment\nname: Review\ninvalid line\n---\nBody')

    expect(parsed.front.fields).toEqual({ name: 'Review' })
  })

  it('preserves separators inside the instruction body', () => {
    const parsed = parseFrontmatter('---\nname: Review\n---\nBefore\n---\nAfter')

    expect(parsed.body).toBe('Before\n---\nAfter')
  })
})

describe('parseGitSpec', () => {
  it.each([
    'https://github.com/example/skills.git',
    'http://example.test/skills.git',
    'git@github.com:example/skills.git',
    'ssh://git@example.com/example/skills.git'
  ])('accepts the supported URL %s', (url) => {
    expect(parseGitSpec(url)).toEqual({ url, ref: undefined, subdir: undefined })
  })

  it('trims surrounding whitespace', () => {
    expect(parseGitSpec('  https://example.test/skills.git  ')).toEqual({
      url: 'https://example.test/skills.git',
      ref: undefined,
      subdir: undefined
    })
  })

  it('parses a branch, tag, or commit ref', () => {
    expect(parseGitSpec('https://example.test/skills.git#release-1')).toEqual({
      url: 'https://example.test/skills.git',
      ref: 'release-1',
      subdir: undefined
    })
  })

  it('parses a ref and nested subdirectory', () => {
    expect(parseGitSpec('https://example.test/skills.git#main:skills/security')).toEqual({
      url: 'https://example.test/skills.git',
      ref: 'main',
      subdir: 'skills/security'
    })
  })

  it('parses a subdirectory without a ref', () => {
    expect(parseGitSpec('https://example.test/skills.git#:skills/security')).toEqual({
      url: 'https://example.test/skills.git',
      ref: undefined,
      subdir: 'skills/security'
    })
  })

  it('trims whitespace and slashes around the subdirectory', () => {
    expect(parseGitSpec('https://example.test/skills.git# main : /skills/security/ ')).toEqual({
      url: 'https://example.test/skills.git',
      ref: 'main',
      subdir: 'skills/security'
    })
  })

  it.each([
    ['', 'Enter a Git repository URL.'],
    ['   ', 'Enter a Git repository URL.'],
    ['/local/repository', 'Only https:// or ssh git URLs are supported.'],
    ['file:///tmp/skills', 'Only https:// or ssh git URLs are supported.'],
    ['git://example.test/skills.git', 'Only https:// or ssh git URLs are supported.']
  ])('rejects invalid spec %j', (spec, message) => {
    expect(() => parseGitSpec(spec)).toThrow(message)
  })
})

describe('resolveGitSubdir', () => {
  const root = resolve('/tmp/botspector-skill-root')

  it('returns the root when no subdirectory is requested', () => {
    expect(resolveGitSubdir(root)).toBe(root)
  })

  it('resolves a nested subdirectory beneath the root', () => {
    expect(resolveGitSubdir(root, 'skills/security')).toBe(join(root, 'skills', 'security'))
  })

  it.each([
    '../outside',
    'nested/../../outside',
    '../botspector-skill-root-evil'
  ])('rejects traversal through %j', (subdir) => {
    expect(() => resolveGitSubdir(root, subdir)).toThrow('Invalid subdirectory')
  })

  it('rejects an absolute path outside the root', () => {
    expect(() => resolveGitSubdir(root, resolve(root, '..', 'outside'))).toThrow(
      'Invalid subdirectory'
    )
  })
})

describe('repoName', () => {
  it.each([
    ['https://github.com/example/security-review.git', 'security-review'],
    ['https://github.com/example/security-review', 'security-review'],
    ['https://github.com/example/security-review/', 'security-review'],
    ['git@github.com:example/security-review.git', 'security-review'],
    ['ssh://git@example.com/example/security-review.git', 'security-review']
  ])('extracts %j from %j', (url, expected) => {
    expect(repoName(url)).toBe(expected)
  })
})