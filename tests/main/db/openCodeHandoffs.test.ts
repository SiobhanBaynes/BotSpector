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
  createOpenCodeHandoff,
  getOpenCodeHandoff,
  listChatMessages
} from '../../../src/main/db/repo'

describe('OpenCode handoff persistence', () => {
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
           VALUES (42, 'profile', 'Handoff', 'Siobhan', 'active', 'https://example.test/pr/42')`
        )
        .run().lastInsertRowid
    )
  })

  afterEach(() => {
    database.close()
    state.database = null
  })

  it('stores the linked session and syncs transcript and diff atomically', () => {
    const created = createOpenCodeHandoff(prId, {
      sessionId: 'session-1',
      worktreePath: '/tmp/worktree',
      branchName: 'botspector/pr-42',
      baseCommit: 'abcdef12',
      seedMessageId: 'seed-1'
    })

    expect(created).toMatchObject({
      sessionId: 'session-1',
      seedMessageId: 'seed-1',
      lastSyncedMessageId: 'seed-1',
      changedFiles: []
    })

    const synced = applyOpenCodeSync(
      prId,
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
    expect(getOpenCodeHandoff(prId)).toEqual(synced)
    expect(listChatMessages(prId)).toEqual([
      { role: 'user', content: 'Make the change.', source: 'opencode' },
      { role: 'assistant', content: 'Done.', source: 'opencode' }
    ])
  })
})
