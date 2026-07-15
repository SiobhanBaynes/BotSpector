import type Database from 'better-sqlite3'

/**
 * Simple sequential migration runner. Each migration bumps user_version.
 */
const MIGRATIONS: Array<(db: Database.Database) => void> = [
  // v1 -> initial schema
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pull_requests (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        ado_pr_id     INTEGER NOT NULL,
        repo          TEXT NOT NULL,
        title         TEXT NOT NULL,
        author        TEXT NOT NULL,
        status        TEXT NOT NULL,
        url           TEXT NOT NULL,
        source_branch TEXT NOT NULL DEFAULT '',
        target_branch TEXT NOT NULL DEFAULT '',
        review_status TEXT NOT NULL DEFAULT 'not_reviewed',
        updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (ado_pr_id, repo)
      );

      CREATE TABLE IF NOT EXISTS reviews (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        pr_id        INTEGER NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
        model        TEXT NOT NULL,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        status       TEXT NOT NULL DEFAULT 'complete',
        raw_response TEXT
      );

      CREATE TABLE IF NOT EXISTS findings (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        review_id   INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
        public_id   TEXT NOT NULL,
        bucket      TEXT NOT NULL,
        title       TEXT NOT NULL,
        description TEXT NOT NULL,
        file_path   TEXT,
        line        INTEGER,
        status      TEXT NOT NULL DEFAULT 'open',
        explanation TEXT
      );

      CREATE TABLE IF NOT EXISTS comments (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        finding_id    INTEGER NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
        draft_text    TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'draft',
        posted_at     TEXT,
        ado_thread_id INTEGER,
        UNIQUE (finding_id)
      );

      CREATE INDEX IF NOT EXISTS idx_reviews_pr ON reviews(pr_id);
      CREATE INDEX IF NOT EXISTS idx_findings_review ON findings(review_id);
    `)
  },
  // v2 -> add PR description
  (db) => {
    db.exec(`ALTER TABLE pull_requests ADD COLUMN description TEXT NOT NULL DEFAULT ''`)
  },
  // v3 -> track the source-branch head commit at review time for re-review detection
  (db) => {
    db.exec(`ALTER TABLE pull_requests ADD COLUMN head_commit TEXT NOT NULL DEFAULT ''`)
    db.exec(`ALTER TABLE reviews ADD COLUMN reviewed_commit TEXT NOT NULL DEFAULT ''`)
  },
  // v4 -> track whether a PR is still active (present in the latest sync)
  (db) => {
    db.exec(`ALTER TABLE pull_requests ADD COLUMN active INTEGER NOT NULL DEFAULT 1`)
  },
  // v5 -> track the status of posted comment threads (replies / resolution)
  (db) => {
    db.exec(`ALTER TABLE comments ADD COLUMN thread_status TEXT`)
    db.exec(`ALTER TABLE comments ADD COLUMN reply_count INTEGER NOT NULL DEFAULT 0`)
  },
  // v6 -> store the actual reply comments (JSON) for posted threads
  (db) => {
    db.exec(`ALTER TABLE comments ADD COLUMN thread_replies TEXT`)
  }
]

export function runMigrations(db: Database.Database): void {
  const current = (db.pragma('user_version', { simple: true }) as number) ?? 0
  for (let v = current; v < MIGRATIONS.length; v++) {
    const migrate = MIGRATIONS[v]
    const tx = db.transaction(() => {
      migrate(db)
      db.pragma(`user_version = ${v + 1}`)
    })
    tx()
  }
}
