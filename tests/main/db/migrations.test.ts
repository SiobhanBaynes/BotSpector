import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '../../../src/main/db/migrations'

interface NamedRow {
  name: string
}

interface ColumnRow {
  name: string
}

interface ForeignKeyRow {
  from: string
  table: string
  to: string
  on_delete: string
}

describe('runMigrations', () => {
  let database: Database.Database

  beforeEach(() => {
    database = new Database(':memory:')
  })

  afterEach(() => {
    database.close()
  })

  function tableNames(): string[] {
    return database
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`
      )
      .all()
      .map((row) => (row as NamedRow).name)
  }

  function indexNames(): string[] {
    return database
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`
      )
      .all()
      .map((row) => (row as NamedRow).name)
  }

  function columnNames(table: string): string[] {
    return (database.pragma(`table_info(${table})`) as ColumnRow[]).map((column) => column.name)
  }

  it('migrates a fresh database to the latest version', () => {
    runMigrations(database)

    expect(database.pragma('user_version', { simple: true })).toBe(13)
  })

  it('creates every application table', () => {
    runMigrations(database)

    expect(tableNames()).toEqual([
      'chat_messages',
      'comments',
      'findings',
      'posted_comments',
      'pull_requests',
      'review_runs',
      'reviews',
      'settings'
    ])
  })

  it.each([
    ['settings', ['key', 'value']],
    [
      'pull_requests',
      [
        'id',
        'ado_pr_id',
        'repo',
        'title',
        'author',
        'status',
        'url',
        'source_branch',
        'target_branch',
        'review_status',
        'updated_at',
        'description',
        'head_commit',
        'active',
        'is_draft',
        'approvals',
        'reviewer_count',
        'comment_count',
        'unresolved_comment_count',
        'my_vote'
      ]
    ],
    [
      'reviews',
      ['id', 'pr_id', 'model', 'created_at', 'status', 'raw_response', 'reviewed_commit']
    ],
    [
      'review_runs',
      [
        'id',
        'pr_id',
        'model',
        'created_at',
        'reviewed_commit',
        'settings_json',
        'created_findings',
        'contributed_findings'
      ]
    ],
    [
      'findings',
      [
        'id',
        'review_id',
        'public_id',
        'bucket',
        'title',
        'description',
        'file_path',
        'line',
        'status',
        'explanation',
        'model',
        'contributors'
      ]
    ],
    [
      'comments',
      [
        'id',
        'finding_id',
        'draft_text',
        'status',
        'posted_at',
        'ado_thread_id',
        'thread_status',
        'reply_count',
        'thread_replies'
      ]
    ],
    [
      'posted_comments',
      [
        'id',
        'pr_id',
        'ado_thread_id',
        'finding_public_id',
        'finding_title',
        'bucket',
        'comment_text',
        'posted_at',
        'thread_status',
        'reply_count',
        'thread_replies',
        'updated_at'
      ]
    ],
    ['chat_messages', ['id', 'pr_id', 'role', 'content', 'created_at']]
  ])('creates the expected columns for %s', (table, expectedColumns) => {
    runMigrations(database)

    expect(columnNames(table)).toEqual(expectedColumns)
  })

  it('creates indexes used by common relationship lookups', () => {
    runMigrations(database)

    expect(indexNames()).toEqual([
      'idx_chat_messages_pr',
      'idx_findings_review',
      'idx_posted_comments_pr',
      'idx_review_runs_pr',
      'idx_reviews_pr'
    ])
  })

  it.each([
    ['reviews', 'pr_id', 'pull_requests', 'id'],
    ['review_runs', 'pr_id', 'pull_requests', 'id'],
    ['findings', 'review_id', 'reviews', 'id'],
    ['comments', 'finding_id', 'findings', 'id'],
    ['posted_comments', 'pr_id', 'pull_requests', 'id'],
    ['chat_messages', 'pr_id', 'pull_requests', 'id']
  ])(
    'declares the %s.%s foreign key to %s.%s with cascade deletion',
    (table, from, targetTable, to) => {
      runMigrations(database)
      const foreignKeys = database.pragma(`foreign_key_list(${table})`) as ForeignKeyRow[]

      expect(foreignKeys).toContainEqual(
        expect.objectContaining({
          from,
          table: targetTable,
          to,
          on_delete: 'CASCADE'
        })
      )
    }
  )

  it('is idempotent and preserves existing data', () => {
    runMigrations(database)
    database.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('theme', 'dark')

    runMigrations(database)

    expect(database.prepare('SELECT value FROM settings WHERE key = ?').pluck().get('theme')).toBe(
      'dark'
    )
    expect(database.pragma('user_version', { simple: true })).toBe(13)
  })

  it('does not downgrade a database with a newer schema version', () => {
    database.pragma('user_version = 99')

    runMigrations(database)

    expect(database.pragma('user_version', { simple: true })).toBe(99)
    expect(tableNames()).toEqual([])
  })

  it('does not advance the version when a migration fails', () => {
    database.pragma('user_version = 7')

    expect(() => runMigrations(database)).toThrow()
    expect(database.pragma('user_version', { simple: true })).toBe(7)
  })

  it('backfills posted comments and finding models when upgrading version 6', () => {
    database.exec(`
      CREATE TABLE pull_requests (id INTEGER PRIMARY KEY);
      CREATE TABLE reviews (
        id INTEGER PRIMARY KEY,
        pr_id INTEGER NOT NULL,
        model TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        reviewed_commit TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE findings (
        id INTEGER PRIMARY KEY,
        review_id INTEGER NOT NULL,
        public_id TEXT NOT NULL,
        bucket TEXT NOT NULL,
        title TEXT NOT NULL
      );
      CREATE TABLE comments (
        id INTEGER PRIMARY KEY,
        finding_id INTEGER NOT NULL,
        draft_text TEXT NOT NULL,
        status TEXT NOT NULL,
        posted_at TEXT,
        ado_thread_id INTEGER,
        thread_status TEXT,
        reply_count INTEGER NOT NULL DEFAULT 0,
        thread_replies TEXT
      );

      INSERT INTO pull_requests (id) VALUES (1);
      INSERT INTO reviews (id, pr_id, model) VALUES (10, 1, 'gpt-reviewer');
      INSERT INTO findings (id, review_id, public_id, bucket, title)
      VALUES
        (20, 10, 'F-001', 'High', 'Posted issue'),
        (21, 10, 'F-002', 'Low', 'Draft issue');
      INSERT INTO comments
        (id, finding_id, draft_text, status, posted_at, ado_thread_id,
         thread_status, reply_count, thread_replies)
      VALUES
        (30, 20, 'Please fix this.', 'posted', '2026-01-02', 400, 'active', 2, '[{"text":"reply"}]'),
        (31, 21, 'Draft only.', 'draft', NULL, NULL, NULL, 0, NULL);
      PRAGMA user_version = 6;
    `)

    runMigrations(database)

    expect(database.pragma('user_version', { simple: true })).toBe(13)
    expect(database.prepare('SELECT * FROM posted_comments').get()).toMatchObject({
      pr_id: 1,
      ado_thread_id: 400,
      finding_public_id: 'F-001',
      finding_title: 'Posted issue',
      bucket: 'High',
      comment_text: 'Please fix this.',
      posted_at: '2026-01-02',
      thread_status: 'active',
      reply_count: 2,
      thread_replies: '[{"text":"reply"}]'
    })
    expect(database.prepare('SELECT model, contributors FROM findings ORDER BY id').all()).toEqual([
      { model: 'gpt-reviewer', contributors: '[]' },
      { model: 'gpt-reviewer', contributors: '[]' }
    ])
    expect(database.prepare('SELECT * FROM review_runs').get()).toMatchObject({
      pr_id: 1,
      model: 'gpt-reviewer',
      reviewed_commit: '',
      settings_json: null,
      created_findings: '["F-001","F-002"]',
      contributed_findings: '[]'
    })
  })
})