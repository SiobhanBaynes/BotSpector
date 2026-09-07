import { randomUUID } from 'crypto'
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
  },
  // v7 -> track posted comments at the PR level so their Azure DevOps thread
  // status and conversation survive re-reviews (which replace reviews/findings).
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS posted_comments (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        pr_id             INTEGER NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
        ado_thread_id     INTEGER NOT NULL,
        finding_public_id TEXT,
        finding_title     TEXT,
        bucket            TEXT,
        comment_text      TEXT NOT NULL,
        posted_at         TEXT,
        thread_status     TEXT,
        reply_count       INTEGER NOT NULL DEFAULT 0,
        thread_replies    TEXT,
        updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (pr_id, ado_thread_id)
      );

      CREATE INDEX IF NOT EXISTS idx_posted_comments_pr ON posted_comments(pr_id);
    `)

    // Backfill from any existing posted comments so history isn't lost on upgrade.
    db.exec(`
      INSERT OR IGNORE INTO posted_comments
        (pr_id, ado_thread_id, finding_public_id, finding_title, bucket, comment_text,
         posted_at, thread_status, reply_count, thread_replies)
      SELECT r.pr_id, c.ado_thread_id, f.public_id, f.title, f.bucket, c.draft_text,
             c.posted_at, c.thread_status, c.reply_count, c.thread_replies
      FROM comments c
      JOIN findings f ON f.id = c.finding_id
      JOIN reviews r ON r.id = f.review_id
      WHERE c.status = 'posted' AND c.ado_thread_id IS NOT NULL;
    `)
  },
  // v8 -> cache Azure DevOps PR metadata for the list (draft flag, reviewer
  // votes/approvals, and comment-thread count).
  (db) => {
    db.exec(`ALTER TABLE pull_requests ADD COLUMN is_draft INTEGER NOT NULL DEFAULT 0`)
    db.exec(`ALTER TABLE pull_requests ADD COLUMN approvals INTEGER NOT NULL DEFAULT 0`)
    db.exec(`ALTER TABLE pull_requests ADD COLUMN reviewer_count INTEGER NOT NULL DEFAULT 0`)
    db.exec(`ALTER TABLE pull_requests ADD COLUMN comment_count INTEGER NOT NULL DEFAULT 0`)
  },
  // v9 -> track unresolved (active) comment threads separately from the total
  (db) => {
    db.exec(
      `ALTER TABLE pull_requests ADD COLUMN unresolved_comment_count INTEGER NOT NULL DEFAULT 0`
    )
  },
  // v10 -> cache the current user's own reviewer vote so we can drop PRs we've
  // already approved out of the review queue.
  (db) => {
    db.exec(`ALTER TABLE pull_requests ADD COLUMN my_vote INTEGER NOT NULL DEFAULT 0`)
  },
  // v11 -> persist per-PR chat conversations (visible turns only).
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        pr_id      INTEGER NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
        role       TEXT NOT NULL,
        content    TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_chat_messages_pr ON chat_messages(pr_id, id);
    `)
  },
  // v12 -> tag each finding with the model that raised it and any models that
  // later contributed to it, so multiple agents can review one PR.
  (db) => {
    db.exec(`ALTER TABLE findings ADD COLUMN model TEXT NOT NULL DEFAULT ''`)
    db.exec(`ALTER TABLE findings ADD COLUMN contributors TEXT NOT NULL DEFAULT '[]'`)
    // Backfill each existing finding's model from its parent review.
    db.exec(`
      UPDATE findings
      SET model = COALESCE((SELECT r.model FROM reviews r WHERE r.id = findings.review_id), '')
      WHERE model = ''
    `)
  },
  // v13 -> keep an immutable record of every review pass, including the exact
  // skill and review options used. The reviews table continues to own the live
  // findings for each model, while review_runs provides durable history.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS review_runs (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        pr_id                INTEGER NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
        model                TEXT NOT NULL,
        created_at           TEXT NOT NULL DEFAULT (datetime('now')),
        reviewed_commit      TEXT NOT NULL DEFAULT '',
        settings_json        TEXT,
        created_findings     TEXT NOT NULL DEFAULT '[]',
        contributed_findings TEXT NOT NULL DEFAULT '[]'
      );

      CREATE INDEX IF NOT EXISTS idx_review_runs_pr ON review_runs(pr_id, created_at DESC, id DESC);

      INSERT INTO review_runs
        (pr_id, model, created_at, reviewed_commit, settings_json,
         created_findings, contributed_findings)
      SELECT
        r.pr_id,
        r.model,
        r.created_at,
        r.reviewed_commit,
        NULL,
        COALESCE(
          (SELECT json_group_array(f.public_id)
           FROM findings f
           WHERE f.review_id = r.id),
          '[]'
        ),
        COALESCE(
          (SELECT json_group_array(f.public_id)
           FROM findings f
           JOIN reviews owner ON owner.id = f.review_id
           WHERE owner.pr_id = r.pr_id
             AND COALESCE(f.model, '') <> r.model
             AND EXISTS (
               SELECT 1
               FROM json_each(COALESCE(f.contributors, '[]'))
               WHERE value = r.model
             )),
          '[]'
        )
      FROM reviews r;
    `)
  },
  // v14 -> store named repository profiles and migrate the active legacy
  // repository without disturbing its PR and review history.
  (db) => {
    db.exec(`
      CREATE TABLE repository_profiles (
        id          TEXT PRIMARY KEY,
        nickname    TEXT NOT NULL COLLATE NOCASE CHECK (length(trim(nickname)) > 0),
        ado_org     TEXT NOT NULL COLLATE NOCASE CHECK (length(trim(ado_org)) > 0),
        ado_project TEXT NOT NULL COLLATE NOCASE CHECK (length(trim(ado_project)) > 0),
        ado_repo    TEXT NOT NULL COLLATE NOCASE CHECK (length(trim(ado_repo)) > 0),
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        archived_at TEXT,
        UNIQUE (ado_org, ado_project, ado_repo)
      );

      CREATE UNIQUE INDEX idx_repository_profiles_nickname_active
      ON repository_profiles(nickname)
      WHERE archived_at IS NULL;
    `)

    const rows = db
      .prepare(
        `SELECT key, value FROM settings
         WHERE key IN ('adoOrg', 'adoProject', 'adoRepo')`
      )
      .all() as Array<{ key: string; value: string }>
    const legacy = Object.fromEntries(rows.map((row) => [row.key, row.value.trim()]))
    const adoOrg = legacy.adoOrg ?? ''
    const adoProject = legacy.adoProject ?? ''
    const adoRepo = legacy.adoRepo ?? ''
    if (!adoOrg || !adoProject || !adoRepo) return

    const profileId = randomUUID()
    db.prepare(
      `INSERT INTO repository_profiles (id, nickname, ado_org, ado_project, ado_repo)
       VALUES (?, ?, ?, ?, ?)`
    ).run(profileId, adoRepo, adoOrg, adoProject, adoRepo)
    db.prepare(
      `INSERT INTO settings (key, value) VALUES ('activeRepositoryProfileId', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(profileId)

    let repositoryKeys = db
      .prepare(
        `SELECT DISTINCT repo
         FROM pull_requests
         WHERE repo = ? COLLATE NOCASE`
      )
      .all(adoRepo) as Array<{ repo: string }>
    if (repositoryKeys.length === 0) {
      const activeRepositoryKeys = db
        .prepare('SELECT DISTINCT repo FROM pull_requests WHERE active = 1')
        .all() as Array<{ repo: string }>
      if (activeRepositoryKeys.length === 1) repositoryKeys = activeRepositoryKeys
    }
    if (repositoryKeys.length === 0) {
      const allRepositoryKeys = db
        .prepare('SELECT DISTINCT repo FROM pull_requests')
        .all() as Array<{
        repo: string
      }>
      if (allRepositoryKeys.length === 1) repositoryKeys = allRepositoryKeys
    }
    const assignProfile = db.prepare('UPDATE pull_requests SET repo = ? WHERE repo = ?')
    for (const repositoryKey of repositoryKeys) {
      assignProfile.run(profileId, repositoryKey.repo)
    }
  },
  // v15 -> scope the Azure DevOps display identity to each repository profile.
  // Existing profiles inherit the legacy global identity so upgrades preserve
  // the current PR ownership and filtering behavior.
  (db) => {
    db.exec(`ALTER TABLE repository_profiles ADD COLUMN my_identity TEXT NOT NULL DEFAULT ''`)
    db.exec(`
      UPDATE repository_profiles
      SET my_identity = COALESCE(
        (SELECT value FROM settings WHERE key = 'myIdentity'),
        ''
      )
    `)
  },
  // v16 -> optionally link repository profiles to a local checkout and retain
  // the OpenCode session associated with a PR handoff.
  (db) => {
    db.exec(
      `ALTER TABLE repository_profiles ADD COLUMN local_checkout_path TEXT NOT NULL DEFAULT ''`
    )
    const hasChatMessages = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chat_messages'")
      .get()
    if (hasChatMessages) {
      db.exec(`ALTER TABLE chat_messages ADD COLUMN source TEXT NOT NULL DEFAULT 'botspector'`)
    }
    db.exec(`
      CREATE TABLE opencode_handoffs (
        id                     INTEGER PRIMARY KEY AUTOINCREMENT,
        pr_id                  INTEGER NOT NULL UNIQUE REFERENCES pull_requests(id) ON DELETE CASCADE,
        session_id             TEXT NOT NULL UNIQUE,
        worktree_path          TEXT NOT NULL,
        branch_name            TEXT NOT NULL,
        base_commit            TEXT NOT NULL,
        seed_message_id        TEXT,
        last_synced_message_id TEXT,
        changed_files_json     TEXT NOT NULL DEFAULT '[]',
        created_at             TEXT NOT NULL DEFAULT (datetime('now')),
        last_synced_at         TEXT
      );

      CREATE INDEX idx_opencode_handoffs_pr ON opencode_handoffs(pr_id);
    `)
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
