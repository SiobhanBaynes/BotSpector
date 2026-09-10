import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runMigrations } from '../../../src/main/db/migrations'

const state = vi.hoisted(() => ({ database: null as Database.Database | null }))

vi.mock('../../../src/main/db/db', () => ({
  getDb: (): Database.Database => {
    if (!state.database) throw new Error('Test database is not ready')
    return state.database
  }
}))

import {
  applyOpenCodeSync,
  createReview,
  createOpenCodeHandoff,
  getOpenCodeHandoffForFinding,
  listOpenCodeHandoffs,
  listChatMessages,
  setOpenCodeFixAssessment,
  setOpenCodeLastPushedCommit,
  setOpenCodePrAssessment
} from '../../../src/main/db/repo'

describe('OpenCode handoff persistence', () => {
  let database: Database.Database
  let prId: number
  let findingId: number

  beforeEach(() => {
    database = new Database(':memory:')
    database.pragma('foreign_keys = ON')
    state.database = database
    runMigrations(database)
    prId = Number(
      database
        .prepare(
          `INSERT INTO pull_requests (ado_pr_id, repo, title, author, status, url)
           VALUES (42, 'profile', 'Handoff', 'Siobhan', 'active', 'https://example.test/pr/42')`
        )
        .run().lastInsertRowid
    )
    const reviewId = Number(
      database.prepare("INSERT INTO reviews (pr_id, model) VALUES (?, 'test-model')").run(prId)
        .lastInsertRowid
    )
    findingId = Number(
      database
        .prepare(
          `INSERT INTO findings
             (review_id, public_id, bucket, title, description, status)
           VALUES (?, 'F-001', 'High', 'Validate input', 'Reject malformed values.', 'open')`
        )
        .run(reviewId).lastInsertRowid
    )
  })

  afterEach(() => {
    database.close()
    state.database = null
  })

  it('stores the linked session and syncs transcript and diff atomically', () => {
    const created = createOpenCodeHandoff(prId, findingId, {
      sessionId: 'session-1',
      worktreePath: '/tmp/worktree',
      branchName: 'botspector/pr-42',
      baseCommit: 'abcdef12',
      seedMessageId: 'seed-1'
    })

    expect(created).toMatchObject({
      findingId,
      findingPublicId: 'F-001',
      sessionId: 'session-1',
      seedMessageId: 'seed-1',
      lastSyncedMessageId: 'seed-1',
      lastPushedCommit: null,
      changedFiles: []
    })

    const synced = applyOpenCodeSync(
      findingId,
      [
        { role: 'user', content: 'Make the change.', source: 'opencode' },
        { role: 'assistant', content: 'Done.', source: 'opencode' }
      ],
      'assistant-1',
      [{ path: 'src/main.ts', additions: 4, deletions: 1 }]
    )

    expect(synced).toMatchObject({
      lastSyncedMessageId: 'assistant-1',
      changedFiles: [{ path: 'src/main.ts', additions: 4, deletions: 1 }]
    })
    expect(synced.lastSyncedAt).not.toBeNull()
    expect(getOpenCodeHandoffForFinding(findingId)).toEqual(synced)
    expect(listOpenCodeHandoffs(prId)).toEqual([synced])
    expect(listChatMessages(prId)).toEqual([
      {
        role: 'user',
        content: 'Make the change.',
        source: 'opencode',
        findingId,
        findingPublicId: 'F-001'
      },
      {
        role: 'assistant',
        content: 'Done.',
        source: 'opencode',
        findingId,
        findingPublicId: 'F-001'
      }
    ])

    const assessed = setOpenCodeFixAssessment(findingId, {
      verdict: 'resolved',
      explanation: 'The worktree now rejects malformed values.'
    })
    expect(assessed.fixAssessment).toMatchObject({
      verdict: 'resolved',
      explanation: 'The worktree now rejects malformed values.'
    })
    expect(assessed.fixAssessment?.checkedAt).toBeTruthy()
    expect(
      database.prepare('SELECT status FROM findings WHERE id = ?').pluck().get(findingId)
    ).toBe('open')

    const prAssessed = setOpenCodePrAssessment(
      findingId,
      { verdict: 'unresolved', explanation: 'The PR branch still has the original issue.' },
      'abcdef12'
    )
    expect(prAssessed.prAssessment).toMatchObject({
      verdict: 'unresolved',
      explanation: 'The PR branch still has the original issue.',
      checkedCommit: 'abcdef12'
    })
    expect(prAssessed.prAssessment?.checkedAt).toBeTruthy()

    const pushed = setOpenCodeLastPushedCommit(findingId, '1234567890abcdef')
    expect(pushed.lastPushedCommit).toBe('1234567890abcdef')
    expect(getOpenCodeHandoffForFinding(findingId)?.lastPushedCommit).toBe('1234567890abcdef')

    const resynced = applyOpenCodeSync(findingId, [], 'assistant-1', [])
    expect(resynced.fixAssessment).toBeNull()
    expect(resynced.prAssessment).toEqual(prAssessed.prAssessment)
  })

  it('stores an independent session for each finding on the same PR', () => {
    const reviewId = database
      .prepare('SELECT review_id FROM findings WHERE id = ?')
      .pluck()
      .get(findingId)
    const otherFindingId = Number(
      database
        .prepare(
          `INSERT INTO findings
             (review_id, public_id, bucket, title, description, status)
           VALUES (?, 'F-002', 'Medium', 'Handle timeout', 'Report timeouts.', 'open')`
        )
        .run(reviewId).lastInsertRowid
    )

    createOpenCodeHandoff(prId, findingId, {
      sessionId: 'session-1',
      worktreePath: '/tmp/worktree-1',
      branchName: 'botspector/pr-42-f-001',
      baseCommit: 'abcdef12',
      seedMessageId: 'seed-1'
    })
    createOpenCodeHandoff(prId, otherFindingId, {
      sessionId: 'session-2',
      worktreePath: '/tmp/worktree-2',
      branchName: 'botspector/pr-42-f-002',
      baseCommit: 'abcdef12',
      seedMessageId: 'seed-2'
    })

    expect(listOpenCodeHandoffs(prId).map((handoff) => handoff.findingPublicId)).toEqual([
      'F-001',
      'F-002'
    ])
  })

  it('preserves a linked finding and handoff across re-review', () => {
    createOpenCodeHandoff(prId, findingId, {
      sessionId: 'session-1',
      worktreePath: '/tmp/worktree',
      branchName: 'botspector/pr-42-f-001',
      baseCommit: 'abcdef12',
      seedMessageId: 'seed-1'
    })

    createReview(
      prId,
      'test-model',
      [
        {
          publicId: 'F-002',
          bucket: 'Medium',
          title: 'A new finding',
          description: 'Found on the next pass.',
          filePath: 'src/new.ts',
          line: 12
        }
      ],
      '{"findings":[]}',
      '12345678'
    )

    expect(getOpenCodeHandoffForFinding(findingId)).toMatchObject({
      findingId,
      findingPublicId: 'F-001',
      sessionId: 'session-1'
    })
    expect(
      database.prepare('SELECT public_id FROM findings WHERE id = ?').pluck().get(findingId)
    ).toBe('F-001')
  })
})
