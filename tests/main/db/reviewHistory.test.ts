import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReviewRunSettings } from '../../../src/shared/types'
import { runMigrations } from '../../../src/main/db/migrations'

const state = vi.hoisted(() => ({ database: null as Database.Database | null }))

vi.mock('../../../src/main/db/db', () => ({
  getDb: (): Database.Database => {
    if (!state.database) throw new Error('Test database is not ready')
    return state.database
  }
}))

import { createReview, listReviewSummaries, type NewFinding } from '../../../src/main/db/repo'

function finding(publicId: string, title = publicId): NewFinding {
  return {
    publicId,
    bucket: 'Medium',
    title,
    description: `${title} description`,
    filePath: 'src/example.ts',
    line: 12
  }
}

function settings(overrides: Partial<ReviewRunSettings> = {}): ReviewRunSettings {
  return {
    depth: 'quick',
    models: ['gpt-reviewer'],
    skills: [
      {
        id: 'general',
        name: 'General review',
        description: 'Broad code review',
        source: 'builtin',
        version: null,
        instructions: 'Review carefully.',
        instructionsOverridden: false,
        filePatterns: [],
        toolAllowlist: []
      }
    ],
    ...overrides
  }
}

describe('review history persistence', () => {
  let database: Database.Database
  let prId: number

  beforeEach(() => {
    database = new Database(':memory:')
    database.pragma('foreign_keys = ON')
    state.database = database
    runMigrations(database)
    prId = Number(
      database
        .prepare(
          `INSERT INTO pull_requests (ado_pr_id, repo, title, author, status, url)
           VALUES (101, 'BotSpector', 'Test PR', 'Reviewer', 'active', 'https://example.test/pr/101')`
        )
        .run().lastInsertRowid
    )
  })

  afterEach(() => {
    database.close()
    state.database = null
  })

  it('stores the exact settings and findings for a completed pass', () => {
    const snapshot = settings({
      depth: 'intensive',
      models: ['gpt-reviewer', 'claude-reviewer'],
      skills: [
        {
          id: 'security',
          name: 'Security review',
          description: 'Security focus',
          source: 'user',
          version: '2.1',
          instructions: 'Use these customized instructions.',
          instructionsOverridden: true,
          filePatterns: ['**/*.ts'],
          toolAllowlist: ['repo_file']
        }
      ]
    })

    createReview(prId, 'gpt-reviewer', [finding('F-001')], '{}', 'abc123', {
      settings: snapshot,
      contributedFindings: ['F-099']
    })

    expect(listReviewSummaries(prId)).toEqual([
      expect.objectContaining({
        model: 'gpt-reviewer',
        reviewedCommit: 'abc123',
        settings: snapshot,
        createdFindings: ['F-001'],
        contributedFindings: ['F-099']
      })
    ])
  })

  it('keeps reruns of the same model as separate history entries', () => {
    createReview(prId, 'gpt-reviewer', [finding('F-001')], '{}', 'first', {
      settings: settings(),
      contributedFindings: []
    })
    createReview(prId, 'gpt-reviewer', [finding('F-002')], '{}', 'second', {
      settings: settings({ depth: 'intensive' }),
      contributedFindings: ['F-010']
    })

    const history = listReviewSummaries(prId)
    expect(history).toHaveLength(2)
    expect(history.map((run) => run.reviewedCommit)).toEqual(['second', 'first'])
    expect(history.map((run) => run.settings?.depth)).toEqual(['intensive', 'quick'])
    expect(history.map((run) => run.createdFindings)).toEqual([['F-002'], ['F-001']])
  })

  it('records the actual public ID when a requested ID is already in use', () => {
    createReview(prId, 'first-model', [finding('F-001')], '{}', 'first', {
      settings: settings({ models: ['first-model'] }),
      contributedFindings: []
    })
    createReview(prId, 'second-model', [finding('F-001')], '{}', 'second', {
      settings: settings({ models: ['second-model'] }),
      contributedFindings: []
    })

    const secondRun = listReviewSummaries(prId)[0]
    expect(secondRun.model).toBe('second-model')
    expect(secondRun.createdFindings).toEqual(['F-002'])
  })

  it('stores a detached snapshot rather than a mutable settings reference', () => {
    const snapshot = settings()
    createReview(prId, 'gpt-reviewer', [], '{}', 'abc123', {
      settings: snapshot,
      contributedFindings: []
    })

    snapshot.depth = 'intensive'
    snapshot.models.push('later-model')
    snapshot.skills[0].instructions = 'Changed later.'

    expect(listReviewSummaries(prId)[0].settings).toEqual(settings())
  })

  it('returns safe fallbacks for malformed stored JSON', () => {
    database
      .prepare(
        `INSERT INTO review_runs
          (pr_id, model, settings_json, created_findings, contributed_findings)
         VALUES (?, 'broken-model', '{}', '{bad', 'not-an-array')`
      )
      .run(prId)

    expect(listReviewSummaries(prId)[0]).toEqual(
      expect.objectContaining({
        settings: null,
        createdFindings: [],
        contributedFindings: []
      })
    )
  })

  it('only returns history for the requested pull request', () => {
    const otherPrId = Number(
      database
        .prepare(
          `INSERT INTO pull_requests (ado_pr_id, repo, title, author, status, url)
           VALUES (102, 'BotSpector', 'Other PR', 'Reviewer', 'active', 'https://example.test/pr/102')`
        )
        .run().lastInsertRowid
    )
    createReview(prId, 'first-model', [], '{}', 'first', {
      settings: settings({ models: ['first-model'] }),
      contributedFindings: []
    })
    createReview(otherPrId, 'second-model', [], '{}', 'second', {
      settings: settings({ models: ['second-model'] }),
      contributedFindings: []
    })

    expect(listReviewSummaries(prId).map((run) => run.model)).toEqual(['first-model'])
  })
})
