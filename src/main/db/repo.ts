import { getDb } from './db'
import type {
  ChatMessage,
  Comment,
  Finding,
  FindingBucket,
  FindingStatus,
  PostedComment,
  PullRequest,
  Review,
  ReviewStatus
} from '../../shared/types'

// ---- settings ----

const DEFAULT_SETTINGS: Record<string, string> = {
  adoOrg: '',
  adoProject: '',
  adoRepo: '',
  model: ''
}

export function getSetting(key: string): string {
  const db = getDb()
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? DEFAULT_SETTINGS[key] ?? ''
}

export function setSetting(key: string, value: string): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO settings(key, value) VALUES(?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value)
}

// ---- pull requests ----

interface PrRow {
  id: number
  ado_pr_id: number
  repo: string
  title: string
  description: string
  author: string
  status: string
  url: string
  source_branch: string
  target_branch: string
  head_commit: string
  reviewed_commit: string | null
  review_status: string
  posted_comments: number | null
  unaddressed_comments: number | null
  comment_replies: number | null
  is_draft: number | null
  approvals: number | null
  reviewer_count: number | null
  comment_count: number | null
  unresolved_comment_count: number | null
  my_vote: number | null
  updated_at: string
}

function mapPr(row: PrRow): PullRequest {
  return {
    id: row.id,
    adoPrId: row.ado_pr_id,
    repo: row.repo,
    title: row.title,
    description: row.description ?? '',
    author: row.author,
    status: row.status,
    url: row.url,
    sourceBranch: row.source_branch,
    targetBranch: row.target_branch,
    headCommit: row.head_commit ?? '',
    reviewedCommit: row.reviewed_commit ?? null,
    reviewStatus: row.review_status as ReviewStatus,
    postedComments: row.posted_comments ?? 0,
    unaddressedComments: row.unaddressed_comments ?? 0,
    commentReplies: row.comment_replies ?? 0,
    isDraft: !!row.is_draft,
    approvals: row.approvals ?? 0,
    reviewerCount: row.reviewer_count ?? 0,
    commentCount: row.comment_count ?? 0,
    unresolvedCommentCount: row.unresolved_comment_count ?? 0,
    myVote: row.my_vote ?? 0,
    updatedAt: row.updated_at
  }
}

export function upsertPullRequest(
  pr: Omit<
    PullRequest,
    | 'id'
    | 'reviewStatus'
    | 'reviewedCommit'
    | 'postedComments'
    | 'unaddressedComments'
    | 'commentReplies'
    | 'commentCount'
    | 'unresolvedCommentCount'
    | 'myVote'
  >
): number {
  const db = getDb()
  const result = db
    .prepare(
      `INSERT INTO pull_requests
         (ado_pr_id, repo, title, description, author, status, url, source_branch, target_branch, head_commit, is_draft, approvals, reviewer_count, updated_at, active)
       VALUES (@adoPrId, @repo, @title, @description, @author, @status, @url, @sourceBranch, @targetBranch, @headCommit, @isDraft, @approvals, @reviewerCount, @updatedAt, 1)
       ON CONFLICT(ado_pr_id, repo) DO UPDATE SET
         title = excluded.title,
         description = CASE WHEN excluded.description != '' THEN excluded.description ELSE pull_requests.description END,
         author = excluded.author,
         status = excluded.status,
         url = excluded.url,
         source_branch = excluded.source_branch,
         target_branch = excluded.target_branch,
         head_commit = CASE WHEN excluded.head_commit != '' THEN excluded.head_commit ELSE pull_requests.head_commit END,
         is_draft = excluded.is_draft,
         approvals = excluded.approvals,
         reviewer_count = excluded.reviewer_count,
         updated_at = excluded.updated_at,
         active = 1`
    )
    .run({ ...pr, isDraft: pr.isDraft ? 1 : 0 })
  if (result.lastInsertRowid) return Number(result.lastInsertRowid)
  const row = db
    .prepare('SELECT id FROM pull_requests WHERE ado_pr_id = ? AND repo = ?')
    .get(pr.adoPrId, pr.repo) as { id: number }
  return row.id
}

/** Update the cached Azure DevOps comment-thread count for a PR. */
export function updatePrCommentCount(prId: number, count: number): void {
  getDb().prepare('UPDATE pull_requests SET comment_count = ? WHERE id = ?').run(count, prId)
}

/** Update cached Azure DevOps list metadata (draft, approvals, votes, comments). */
export function updatePrAdoMeta(
  prId: number,
  meta: {
    isDraft: boolean
    approvals: number
    reviewerCount: number
    commentCount: number
    unresolvedCommentCount: number
    myVote: number
  }
): void {
  getDb()
    .prepare(
      `UPDATE pull_requests
       SET is_draft = ?, approvals = ?, reviewer_count = ?, comment_count = ?, unresolved_comment_count = ?, my_vote = ?
       WHERE id = ?`
    )
    .run(
      meta.isDraft ? 1 : 0,
      meta.approvals,
      meta.reviewerCount,
      meta.commentCount,
      meta.unresolvedCommentCount,
      meta.myVote,
      prId
    )
}

const PR_SELECT = `
  SELECT p.*,
    (SELECT r.reviewed_commit FROM reviews r WHERE r.pr_id = p.id ORDER BY r.created_at DESC LIMIT 1) AS reviewed_commit,
    (SELECT COUNT(*) FROM comments c
       JOIN findings f ON f.id = c.finding_id
       JOIN reviews r ON r.id = f.review_id
       WHERE r.pr_id = p.id AND c.status = 'posted' AND c.ado_thread_id IS NOT NULL) AS posted_comments,
    (SELECT COUNT(*) FROM comments c
       JOIN findings f ON f.id = c.finding_id
       JOIN reviews r ON r.id = f.review_id
       WHERE r.pr_id = p.id AND c.status = 'posted' AND c.ado_thread_id IS NOT NULL
         AND COALESCE(c.reply_count, 0) = 0
         AND LOWER(COALESCE(c.thread_status, '')) NOT IN ('fixed', 'closed', 'wontfix', 'bydesign')
    ) AS unaddressed_comments,
    (SELECT COALESCE(SUM(c.reply_count), 0) FROM comments c
       JOIN findings f ON f.id = c.finding_id
       JOIN reviews r ON r.id = f.review_id
       WHERE r.pr_id = p.id AND c.status = 'posted') AS comment_replies
  FROM pull_requests p`

export function listPullRequests(): PullRequest[] {
  const db = getDb()
  const rows = db
    .prepare(`${PR_SELECT} WHERE p.active = 1 ORDER BY p.updated_at DESC`)
    .all() as PrRow[]
  return rows.map(mapPr)
}

/** Mark all PRs inactive; the next sync re-activates those still present. */
export function markAllPullRequestsInactive(): void {
  getDb().prepare('UPDATE pull_requests SET active = 0').run()
}

export function getPullRequest(id: number): PullRequest | null {
  const db = getDb()
  const row = db.prepare(`${PR_SELECT} WHERE p.id = ?`).get(id) as PrRow | undefined
  return row ? mapPr(row) : null
}

export function setReviewStatus(prId: number, status: ReviewStatus): void {
  getDb().prepare('UPDATE pull_requests SET review_status = ? WHERE id = ?').run(status, prId)
  // Reaching a fully-reviewed state (manually, via Approve, or once every
  // finding is triaged) means we've signed off on the PR at its current head,
  // so stamp the latest review with the current commit to clear staleness.
  if (status === 'reviewed') captureReviewedCommit(prId)
}

/**
 * Stamp the PR's most recent review with the PR's current head commit, so the
 * "changed since we reviewed it" (stale) check resets. Called whenever a PR
 * reaches the 'reviewed' state.
 */
export function captureReviewedCommit(prId: number): void {
  getDb()
    .prepare(
      `UPDATE reviews
         SET reviewed_commit = (SELECT head_commit FROM pull_requests WHERE id = @prId)
       WHERE id = (
         SELECT id FROM reviews WHERE pr_id = @prId ORDER BY created_at DESC LIMIT 1
       )`
    )
    .run({ prId })
}

/**
 * Recover PRs left in the 'reviewing' state by a review that never finished
 * (e.g. the app was quit or the main process restarted mid-review). Runs at
 * startup: a PR with open findings becomes 'in_progress', one whose findings are
 * all triaged becomes 'reviewed', otherwise it reverts to 'not_reviewed'.
 */
export function resetStuckReviews(): number {
  const result = getDb()
    .prepare(
      `UPDATE pull_requests
       SET review_status = CASE
         WHEN NOT EXISTS (SELECT 1 FROM reviews r WHERE r.pr_id = pull_requests.id) THEN 'not_reviewed'
         WHEN NOT EXISTS (
           SELECT 1 FROM reviews r JOIN findings f ON f.review_id = r.id
           WHERE r.pr_id = pull_requests.id AND f.status = 'open'
         ) THEN 'reviewed'
         WHEN NOT EXISTS (
           SELECT 1 FROM reviews r JOIN findings f ON f.review_id = r.id
           WHERE r.pr_id = pull_requests.id AND f.status != 'open'
         ) THEN 'review_pending'
         ELSE 'in_progress'
       END
       WHERE review_status = 'reviewing'`
    )
    .run()
  return result.changes
}

/**
 * Derive and persist a PR's review status from its findings:
 *  - no review               -> 'not_reviewed'
 *  - review, no findings      -> 'reviewed' (clean)
 *  - findings, none triaged   -> 'review_pending' (AI reviewed, awaiting your look)
 *  - findings, some triaged   -> 'in_progress'
 *  - findings, all triaged    -> 'reviewed'
 * (Triaged = accepted / dismissed / posted; open = untriaged.)
 */
export function recomputeReviewStatus(prId: number): ReviewStatus {
  const db = getDb()
  const hasReview = db.prepare('SELECT 1 FROM reviews WHERE pr_id = ? LIMIT 1').get(prId)
  if (!hasReview) return 'not_reviewed'
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN f.status = 'open' THEN 1 ELSE 0 END) AS openCount
       FROM findings f JOIN reviews r ON r.id = f.review_id
       WHERE r.pr_id = ?`
    )
    .get(prId) as { total: number; openCount: number | null }
  const total = row.total ?? 0
  const openCount = row.openCount ?? 0
  let status: ReviewStatus
  if (total === 0) status = 'reviewed'
  else if (openCount === total) status = 'review_pending'
  else if (openCount === 0) status = 'reviewed'
  else status = 'in_progress'
  db.prepare('UPDATE pull_requests SET review_status = ? WHERE id = ?').run(status, prId)
  // Once every finding is triaged (accepted/dismissed/posted), we've signed off
  // at the current head — re-stamp the review commit so it isn't flagged stale.
  if (status === 'reviewed') captureReviewedCommit(prId)
  return status
}

/** The internal PR id that a finding belongs to, or null. */
export function getPrIdForFinding(findingId: number): number | null {
  const row = getDb()
    .prepare(
      `SELECT r.pr_id AS prId FROM findings f JOIN reviews r ON r.id = f.review_id WHERE f.id = ?`
    )
    .get(findingId) as { prId: number } | undefined
  return row?.prId ?? null
}

/**
 * Re-derive the status of every already-reviewed PR from its findings. Runs at
 * startup so the "reviewed only when fully triaged" rule applies to PRs that
 * were marked 'reviewed' before the rule existed.
 */
export function recomputeAllReviewStatuses(): void {
  getDb()
    .prepare(
      `UPDATE pull_requests
       SET review_status = CASE
         WHEN NOT EXISTS (
           SELECT 1 FROM reviews r JOIN findings f ON f.review_id = r.id
           WHERE r.pr_id = pull_requests.id AND f.status = 'open'
         ) THEN 'reviewed'
         WHEN NOT EXISTS (
           SELECT 1 FROM reviews r JOIN findings f ON f.review_id = r.id
           WHERE r.pr_id = pull_requests.id AND f.status != 'open'
         ) THEN 'review_pending'
         ELSE 'in_progress'
       END
       WHERE review_status IN ('reviewed', 'in_progress', 'review_pending')
         AND EXISTS (SELECT 1 FROM reviews r WHERE r.pr_id = pull_requests.id)`
    )
    .run()
}

export function updatePullRequestDescription(prId: number, description: string): void {
  getDb().prepare('UPDATE pull_requests SET description = ? WHERE id = ?').run(description, prId)
}

export function updatePullRequestHeadCommit(prId: number, commit: string): void {
  getDb().prepare('UPDATE pull_requests SET head_commit = ? WHERE id = ?').run(commit, prId)
}

// ---- reviews & findings ----

export interface NewFinding {
  publicId: string
  bucket: FindingBucket
  title: string
  description: string
  filePath: string | null
  line: number | null
}

// A note from another model that agrees with / adds to an existing finding.
export interface FindingContribution {
  publicId: string
  note: string
}

/**
 * Store a model's review of a PR. Reviews accumulate per model: re-running the
 * SAME model replaces only its own findings, while other models' findings (and
 * their triage/comments) are left intact. Findings that already have a posted
 * comment are preserved across re-reviews so the comment stays linked to the
 * finding that sourced it. New findings are given PR-unique public ids so they
 * never collide with those raised by another agent.
 */
export function createReview(
  prId: number,
  model: string,
  findings: NewFinding[],
  rawResponse: string,
  reviewedCommit = ''
): number {
  const db = getDb()
  const tx = db.transaction(() => {
    // Reuse this model's existing review row (if any) so we can keep the
    // findings that already have a posted comment.
    const existing = db
      .prepare('SELECT id FROM reviews WHERE pr_id = ? AND model = ? ORDER BY created_at DESC LIMIT 1')
      .get(prId, model) as { id: number } | undefined

    let reviewId: number
    if (existing) {
      reviewId = existing.id
      // Drop this review's transient findings, but keep any that have a posted
      // comment so their source finding (and triage) survives the re-review.
      db.prepare(
        `DELETE FROM findings
         WHERE review_id = @reviewId
           AND id NOT IN (
             SELECT c.finding_id FROM comments c
             WHERE c.finding_id IN (SELECT id FROM findings WHERE review_id = @reviewId)
               AND c.status = 'posted' AND c.ado_thread_id IS NOT NULL
           )`
      ).run({ reviewId })
      db.prepare(
        `UPDATE reviews SET raw_response = ?, reviewed_commit = ?, created_at = datetime('now')
         WHERE id = ?`
      ).run(rawResponse, reviewedCommit, reviewId)
    } else {
      reviewId = Number(
        db
          .prepare(
            `INSERT INTO reviews(pr_id, model, status, raw_response, reviewed_commit)
             VALUES(?, ?, 'complete', ?, ?)`
          )
          .run(prId, model, rawResponse, reviewedCommit).lastInsertRowid
      )
    }

    // Collect public ids already in use on this PR (other models + preserved
    // posted findings) so we can renumber colliding new ids to stay unique.
    const usedRows = db
      .prepare(
        `SELECT f.public_id AS pid FROM findings f
         JOIN reviews r ON r.id = f.review_id WHERE r.pr_id = ?`
      )
      .all(prId) as Array<{ pid: string }>
    const used = new Set(usedRows.map((r) => r.pid))
    let counter = 1
    const nextId = (): string => {
      let id = `F-${String(counter).padStart(3, '0')}`
      while (used.has(id)) {
        counter++
        id = `F-${String(counter).padStart(3, '0')}`
      }
      used.add(id)
      counter++
      return id
    }

    const insert = db.prepare(
      `INSERT INTO findings(review_id, public_id, bucket, title, description, file_path, line, model, contributors)
       VALUES(@reviewId, @publicId, @bucket, @title, @description, @filePath, @line, @model, '[]')`
    )
    for (const f of findings) {
      const publicId = f.publicId && !used.has(f.publicId) ? (used.add(f.publicId), f.publicId) : nextId()
      insert.run({ reviewId, ...f, publicId, model })
    }
    return reviewId
  })
  return tx()
}

/**
 * Record that other models contributed to existing findings (agreed with or
 * added to them). Adds the contributing model to each finding's contributor list
 * and appends its note to the description.
 */
export function applyContributions(
  prId: number,
  model: string,
  contributions: FindingContribution[]
): void {
  if (contributions.length === 0) return
  const db = getDb()
  const tx = db.transaction(() => {
    for (const c of contributions) {
      const row = db
        .prepare(
          `SELECT f.id AS id, f.contributors AS contributors, f.description AS description
           FROM findings f JOIN reviews r ON r.id = f.review_id
           WHERE r.pr_id = ? AND f.public_id = ? LIMIT 1`
        )
        .get(prId, c.publicId) as
        | { id: number; contributors: string | null; description: string }
        | undefined
      if (!row) continue
      let contributors: string[] = []
      try {
        const parsed = JSON.parse(row.contributors ?? '[]')
        if (Array.isArray(parsed)) contributors = parsed.filter((m): m is string => typeof m === 'string')
      } catch {
        contributors = []
      }
      // Already recorded this model's contribution (e.g. on a re-run) — skip so
      // the note isn't appended twice.
      if (contributors.includes(model)) continue
      contributors.push(model)
      const note = c.note.trim()
      const description = note
        ? `${row.description}\n\n[${model} also flagged this: ${note}]`
        : row.description
      db.prepare('UPDATE findings SET contributors = ?, description = ? WHERE id = ?').run(
        JSON.stringify(contributors),
        description,
        row.id
      )
    }
  })
  tx()
}

interface FindingRow {
  id: number
  review_id: number
  public_id: string
  bucket: string
  title: string
  description: string
  file_path: string | null
  line: number | null
  status: string
  explanation: string | null
  model: string | null
  contributors: string | null
}

interface CommentRow {
  id: number
  finding_id: number
  draft_text: string
  status: string
  posted_at: string | null
  ado_thread_id: number | null
  thread_status: string | null
  reply_count: number | null
  thread_replies: string | null
}

function mapComment(row: CommentRow): Comment {
  let replies: Comment['replies'] = []
  if (row.thread_replies) {
    try {
      replies = JSON.parse(row.thread_replies) as Comment['replies']
    } catch {
      replies = []
    }
  }
  return {
    id: row.id,
    findingId: row.finding_id,
    draftText: row.draft_text,
    status: row.status as Comment['status'],
    postedAt: row.posted_at,
    adoThreadId: row.ado_thread_id,
    threadStatus: row.thread_status ?? null,
    replyCount: row.reply_count ?? 0,
    replies
  }
}

function mapFinding(row: FindingRow, comment: Comment | null): Finding {
  let contributors: string[] = []
  if (row.contributors) {
    try {
      const parsed = JSON.parse(row.contributors)
      if (Array.isArray(parsed)) contributors = parsed.filter((m): m is string => typeof m === 'string')
    } catch {
      contributors = []
    }
  }
  return {
    id: row.id,
    reviewId: row.review_id,
    publicId: row.public_id,
    bucket: row.bucket as FindingBucket,
    title: row.title,
    description: row.description,
    filePath: row.file_path,
    line: row.line,
    status: row.status as FindingStatus,
    explanation: row.explanation,
    comment,
    model: row.model ?? '',
    contributors
  }
}

export function getReviewById(reviewId: number): { id: number; prId: number; reviewedCommit: string } | null {
  const db = getDb()
  const row = db
    .prepare('SELECT id, pr_id, reviewed_commit FROM reviews WHERE id = ?')
    .get(reviewId) as { id: number; pr_id: number; reviewed_commit: string } | undefined
  return row ? { id: row.id, prId: row.pr_id, reviewedCommit: row.reviewed_commit ?? '' } : null
}

export function getReviewForPr(prId: number): Review | null {
  const db = getDb()
  // The most recent review anchors the returned object's metadata, but we
  // aggregate findings from every model that has reviewed this PR.
  const review = db
    .prepare('SELECT * FROM reviews WHERE pr_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(prId) as
    | { id: number; pr_id: number; model: string; created_at: string; status: string }
    | undefined
  if (!review) return null

  const findingRows = db
    .prepare(
      `SELECT f.* FROM findings f
       JOIN reviews r ON r.id = f.review_id
       WHERE r.pr_id = ?
       ORDER BY f.id ASC`
    )
    .all(prId) as FindingRow[]

  const findings: Finding[] = findingRows.map((fr) => {
    const commentRow = db
      .prepare('SELECT * FROM comments WHERE finding_id = ?')
      .get(fr.id) as CommentRow | undefined
    return mapFinding(fr, commentRow ? mapComment(commentRow) : null)
  })

  return {
    id: review.id,
    prId: review.pr_id,
    model: review.model,
    createdAt: review.created_at,
    status: review.status as Review['status'],
    findings
  }
}

export function getFinding(findingId: number): Finding | null {
  const db = getDb()
  const fr = db.prepare('SELECT * FROM findings WHERE id = ?').get(findingId) as
    | FindingRow
    | undefined
  if (!fr) return null
  const commentRow = db
    .prepare('SELECT * FROM comments WHERE finding_id = ?')
    .get(findingId) as CommentRow | undefined
  return mapFinding(fr, commentRow ? mapComment(commentRow) : null)
}

export function setFindingStatus(findingId: number, status: FindingStatus): void {
  getDb().prepare('UPDATE findings SET status = ? WHERE id = ?').run(status, findingId)
}

export function setFindingExplanation(findingId: number, explanation: string): void {
  getDb()
    .prepare('UPDATE findings SET explanation = ? WHERE id = ?')
    .run(explanation, findingId)
}

export function upsertComment(findingId: number, draftText: string): void {
  getDb()
    .prepare(
      `INSERT INTO comments(finding_id, draft_text, status) VALUES(?, ?, 'draft')
       ON CONFLICT(finding_id) DO UPDATE SET draft_text = excluded.draft_text`
    )
    .run(findingId, draftText)
}

export function markCommentPosted(findingId: number, adoThreadId: number | null): void {
  getDb()
    .prepare(
      `UPDATE comments SET status = 'posted', posted_at = datetime('now'), ado_thread_id = ?
       WHERE finding_id = ?`
    )
    .run(adoThreadId, findingId)
}

/** All posted comments for a PR that have an Azure DevOps thread id. */
export function getPostedCommentsForPr(
  prId: number
): Array<{ findingId: number; adoThreadId: number }> {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT c.finding_id AS findingId, c.ado_thread_id AS adoThreadId
       FROM comments c
       JOIN findings f ON f.id = c.finding_id
       JOIN reviews r ON r.id = f.review_id
       WHERE r.pr_id = ? AND c.status = 'posted' AND c.ado_thread_id IS NOT NULL`
    )
    .all(prId) as Array<{ findingId: number; adoThreadId: number }>
  return rows
}

export function updateCommentThreadState(
  findingId: number,
  threadStatus: string | null,
  replyCount: number,
  replies: Array<{ author: string; text: string; date: string | null }> = []
): void {
  getDb()
    .prepare(
      'UPDATE comments SET thread_status = ?, reply_count = ?, thread_replies = ? WHERE finding_id = ?'
    )
    .run(threadStatus, replyCount, JSON.stringify(replies), findingId)
}

/** PR ids that have at least one posted comment thread. */
export function getPrIdsWithPostedComments(): number[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT DISTINCT pr_id AS prId FROM posted_comments')
    .all() as Array<{ prId: number }>
  return rows.map((r) => r.prId)
}

// ---- posted comments (PR-level history that survives re-reviews) ----

interface PostedCommentRow {
  id: number
  pr_id: number
  ado_thread_id: number
  finding_public_id: string | null
  finding_title: string | null
  bucket: string | null
  comment_text: string
  posted_at: string | null
  thread_status: string | null
  reply_count: number | null
  thread_replies: string | null
  updated_at: string | null
}

function mapPostedComment(row: PostedCommentRow): PostedComment {
  let replies: PostedComment['replies'] = []
  if (row.thread_replies) {
    try {
      replies = JSON.parse(row.thread_replies) as PostedComment['replies']
    } catch {
      replies = []
    }
  }
  return {
    id: row.id,
    prId: row.pr_id,
    adoThreadId: row.ado_thread_id,
    findingPublicId: row.finding_public_id,
    findingTitle: row.finding_title,
    bucket: (row.bucket as FindingBucket | null) ?? null,
    commentText: row.comment_text,
    postedAt: row.posted_at,
    threadStatus: row.thread_status ?? null,
    replyCount: row.reply_count ?? 0,
    replies,
    updatedAt: row.updated_at
  }
}

/** Record (or refresh) a comment we posted to Azure DevOps for a PR. */
export function recordPostedComment(entry: {
  prId: number
  adoThreadId: number
  findingPublicId: string | null
  findingTitle: string | null
  bucket: string | null
  commentText: string
}): void {
  getDb()
    .prepare(
      `INSERT INTO posted_comments
         (pr_id, ado_thread_id, finding_public_id, finding_title, bucket, comment_text, posted_at)
       VALUES (@prId, @adoThreadId, @findingPublicId, @findingTitle, @bucket, @commentText, datetime('now'))
       ON CONFLICT(pr_id, ado_thread_id) DO UPDATE SET
         finding_public_id = excluded.finding_public_id,
         finding_title = excluded.finding_title,
         bucket = excluded.bucket,
         comment_text = excluded.comment_text`
    )
    .run(entry)
}

/** Update the Azure DevOps thread status / conversation for a posted comment. */
export function updatePostedCommentThreadState(
  prId: number,
  adoThreadId: number,
  threadStatus: string | null,
  replyCount: number,
  replies: Array<{ author: string; text: string; date: string | null }> = []
): void {
  getDb()
    .prepare(
      `UPDATE posted_comments
       SET thread_status = ?, reply_count = ?, thread_replies = ?, updated_at = datetime('now')
       WHERE pr_id = ? AND ado_thread_id = ?`
    )
    .run(threadStatus, replyCount, JSON.stringify(replies), prId, adoThreadId)
}

/** All comments posted for a PR, oldest first. */
export function listPostedComments(prId: number): PostedComment[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT * FROM posted_comments WHERE pr_id = ? ORDER BY posted_at ASC, id ASC')
    .all(prId) as PostedCommentRow[]
  return rows.map(mapPostedComment)
}

// ---- per-PR chat ----

// Cap how many visible turns we retain per PR so the table can't grow unbounded.
const MAX_CHAT_MESSAGES = 200

/** The persisted chat conversation for a PR, oldest first. */
export function listChatMessages(prId: number): ChatMessage[] {
  const rows = getDb()
    .prepare('SELECT role, content FROM chat_messages WHERE pr_id = ? ORDER BY id ASC')
    .all(prId) as Array<{ role: string; content: string }>
  return rows.map((r) => ({ role: r.role === 'assistant' ? 'assistant' : 'user', content: r.content }))
}

/** Append visible turns to a PR's chat and trim to the retention cap. */
export function addChatMessages(prId: number, messages: ChatMessage[]): void {
  if (messages.length === 0) return
  const db = getDb()
  const tx = db.transaction(() => {
    const insert = db.prepare(
      'INSERT INTO chat_messages(pr_id, role, content) VALUES(?, ?, ?)'
    )
    for (const m of messages) insert.run(prId, m.role, m.content)
    // Keep only the most recent MAX_CHAT_MESSAGES rows for this PR.
    db.prepare(
      `DELETE FROM chat_messages
       WHERE pr_id = ? AND id NOT IN (
         SELECT id FROM chat_messages WHERE pr_id = ? ORDER BY id DESC LIMIT ?
       )`
    ).run(prId, prId, MAX_CHAT_MESSAGES)
  })
  tx()
}

/** Delete a PR's entire chat conversation. */
export function clearChatMessages(prId: number): void {
  getDb().prepare('DELETE FROM chat_messages WHERE pr_id = ?').run(prId)
}
