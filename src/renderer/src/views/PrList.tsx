import { useCallback, useEffect, useState } from 'react'
import type { PullRequest, ReviewStatus } from '../../../shared/types'

interface Props {
  onOpen: (prId: number) => void
  myIdentity: string
}

// How often to silently refresh the PR list (and head commits) in the background.
const AUTO_REFRESH_MS = 3 * 60 * 1000

interface Filters {
  excludeMine: boolean
  excludeDrafts: boolean
  approved1: boolean
  approved2: boolean
  openComments: boolean
}

const DEFAULT_FILTERS: Filters = {
  excludeMine: false,
  excludeDrafts: false,
  approved1: false,
  approved2: false,
  openComments: false
}

const FILTERS_KEY = 'botspector.prFilters'

function loadFilters(): Filters {
  try {
    const raw = localStorage.getItem(FILTERS_KEY)
    if (raw) return { ...DEFAULT_FILTERS, ...(JSON.parse(raw) as Partial<Filters>) }
  } catch {
    // ignore malformed stored value
  }
  // Migrate the old standalone "exclude mine" preference.
  return { ...DEFAULT_FILTERS, excludeMine: localStorage.getItem('botspector.excludeMine') === 'true' }
}

function matchesFilters(pr: PullRequest, filters: Filters, myIdentity: string): boolean {
  if (filters.excludeMine && isMine(pr, myIdentity)) return false
  if (filters.excludeDrafts && pr.isDraft) return false
  if (filters.approved1 && pr.approvals < 1) return false
  if (filters.approved2 && pr.approvals < 2) return false
  if (filters.openComments && pr.unresolvedCommentCount < 1) return false
  return true
}

function isMine(pr: PullRequest, myIdentity: string): boolean {
  const id = myIdentity.trim().toLowerCase()
  if (!id) return false
  const author = pr.author.toLowerCase()
  return author === id || author.includes(id) || id.includes(author)
}

// A reviewed PR that has changed since we reviewed it (needs a re-review).
function isStale(pr: PullRequest): boolean {
  return (
    (pr.reviewStatus === 'reviewed' ||
      pr.reviewStatus === 'in_progress' ||
      pr.reviewStatus === 'review_pending') &&
    !!pr.reviewedCommit &&
    !!pr.headCommit &&
    pr.reviewedCommit !== pr.headCommit
  )
}

// Oldest first, by PR creation/update time.
function byOldest(a: PullRequest, b: PullRequest): number {
  return a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0
}

// Never-reviewed PRs first, then oldest first within each group.
function byUnreviewedThenOldest(a: PullRequest, b: PullRequest): number {
  const aNew = a.reviewStatus === 'not_reviewed' ? 0 : 1
  const bNew = b.reviewStatus === 'not_reviewed' ? 0 : 1
  if (aNew !== bNew) return aNew - bNew
  return byOldest(a, b)
}

export function PrList({ onOpen, myIdentity }: Props): JSX.Element {
  const [prs, setPrs] = useState<PullRequest[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null)
  const [bgBusy, setBgBusy] = useState(false)
  const [filters, setFilters] = useState<Filters>(loadFilters)

  // Persist filter selections across sessions.
  useEffect(() => {
    localStorage.setItem(FILTERS_KEY, JSON.stringify(filters))
  }, [filters])

  const toggleFilter = (key: keyof Filters): void =>
    setFilters((f) => ({ ...f, [key]: !f[key] }))

  const refresh = useCallback(async (silent = false): Promise<void> => {
    if (silent) setBgBusy(true)
    else setLoading(true)
    const res = await window.api.listPullRequests()
    if (silent) setBgBusy(false)
    else setLoading(false)
    if (res.ok) {
      setPrs(res.data)
      setError(null)
      setLastRefreshed(new Date())
    } else if (!silent) {
      setError(res.error)
    }
  }, [])

  // On mount, render the last synced PRs from the local DB instantly, then
  // refresh from Azure DevOps in the background so the list feels fast.
  useEffect(() => {
    let cancelled = false
    void window.api.listCachedPullRequests().then((res) => {
      if (!cancelled && res.ok && res.data.length > 0) setPrs(res.data)
    })
    void refresh(true)
    return () => {
      cancelled = true
    }
  }, [refresh])

  // Background auto-refresh so stale reviews get flagged without a manual click.
  useEffect(() => {
    const id = setInterval(() => {
      void refresh(true)
    }, AUTO_REFRESH_MS)
    return () => clearInterval(id)
  }, [refresh])

  // Also refresh when the window regains focus or the tab becomes visible again,
  // so reviews that went stale while you were away surface as soon as you return
  // to the home screen (without waiting for the interval).
  useEffect(() => {
    const onFocus = (): void => void refresh(true)
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void refresh(true)
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh])

  // A review runs in the main process; when one finishes, refresh so its badge
  // flips from "Reviewing…" to the result even if we stayed on the home screen.
  useEffect(() => {
    const unsub = window.api.onReviewDone(() => void refresh(true))
    return unsub
  }, [refresh])

  const changeStatus = useCallback(
    async (prId: number, status: ReviewStatus): Promise<void> => {
      const res = await window.api.setReviewStatus(prId, status)
      if (res.ok) void refresh(true)
    },
    [refresh]
  )

  // Build the review queue: PRs needing re-review first, then in-progress, then
  // oldest first; our own PRs are pulled out into their own section.
  const visible = prs.filter((pr) => matchesFilters(pr, filters, myIdentity))
  const mine = visible.filter((pr) => isMine(pr, myIdentity)).sort(byOldest)
  const others = visible.filter((pr) => !isMine(pr, myIdentity))
  const needsReReview = others.filter(isStale).sort(byOldest)
  const reviewPending = others
    .filter((pr) => !isStale(pr) && pr.reviewStatus === 'review_pending')
    .sort(byOldest)
  const inProgress = others
    .filter((pr) => !isStale(pr) && pr.reviewStatus === 'in_progress')
    .sort(byOldest)
  const queue = others
    .filter(
      (pr) =>
        !isStale(pr) &&
        pr.reviewStatus !== 'review_pending' &&
        pr.reviewStatus !== 'in_progress'
    )
    .sort(byUnreviewedThenOldest)

  return (
    <div className="prlist">
      <div className="prlist-header">
        <h1>Review Queue</h1>
        <div className="prlist-actions">
          {lastRefreshed && (
            <span className="muted small">
              {bgBusy ? 'Updating…' : `Updated ${lastRefreshed.toLocaleTimeString()}`}
            </span>
          )}
          {!lastRefreshed && bgBusy && <span className="muted small">Updating…</span>}
          <button className="btn" onClick={() => refresh()} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="pr-filter-bar">
        <span className="muted small">Filter</span>
        {myIdentity.trim() && (
          <FilterToggle
            label="Exclude mine"
            active={filters.excludeMine}
            onClick={() => toggleFilter('excludeMine')}
          />
        )}
        <FilterToggle
          label="Exclude drafts"
          active={filters.excludeDrafts}
          onClick={() => toggleFilter('excludeDrafts')}
        />
        <FilterToggle
          label="1+ approval"
          active={filters.approved1}
          onClick={() => toggleFilter('approved1')}
        />
        <FilterToggle
          label="2+ approvals"
          active={filters.approved2}
          onClick={() => toggleFilter('approved2')}
        />
        <FilterToggle
          label="Open comments"
          active={filters.openComments}
          onClick={() => toggleFilter('openComments')}
        />
      </div>

      {error && <div className="banner err">{error}</div>}

      {!loading && !bgBusy && visible.length === 0 && !error && (
        <div className="empty">
          <p>Nothing to review here 👀 — try Refresh, adjust the filters, or check your Azure DevOps settings.</p>
        </div>
      )}

      {needsReReview.length > 0 && (
        <PrSection
          title="Needs re-review"
          hint="Reviewed, but the PR changed since"
          prs={needsReReview}
          myIdentity={myIdentity}
          onOpen={onOpen}
          onStatus={changeStatus}
        />
      )}
      {reviewPending.length > 0 && (
        <PrSection
          title="Review pending"
          hint="AI reviewed — awaiting your triage"
          prs={reviewPending}
          myIdentity={myIdentity}
          onOpen={onOpen}
          onStatus={changeStatus}
        />
      )}
      {inProgress.length > 0 && (
        <PrSection
          title="In progress"
          hint="Triage started"
          prs={inProgress}
          myIdentity={myIdentity}
          onOpen={onOpen}
          onStatus={changeStatus}
        />
      )}
      {queue.length > 0 && (
        <PrSection
          title="Review queue"
          hint="Oldest first"
          prs={queue}
          myIdentity={myIdentity}
          onOpen={onOpen}
          onStatus={changeStatus}
        />
      )}
      {mine.length > 0 && (
        <PrSection
          title="Your pull requests"
          hint="Raised by you"
          prs={mine}
          myIdentity={myIdentity}
          onOpen={onOpen}
          onStatus={changeStatus}
        />
      )}
    </div>
  )
}

function PrSection({
  title,
  hint,
  prs,
  myIdentity,
  onOpen,
  onStatus
}: {
  title: string
  hint?: string
  prs: PullRequest[]
  myIdentity: string
  onOpen: (prId: number) => void
  onStatus: (prId: number, status: ReviewStatus) => void
}): JSX.Element {
  return (
    <section className="queue-section">
      <div className="queue-section-head">
        <h2>
          {title} <span className="count">{prs.length}</span>
        </h2>
        {hint && <span className="muted small">{hint}</span>}
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>#</th>
            <th>Title</th>
            <th>Author</th>
            <th>Branch</th>
            <th>Azure DevOps</th>
            <th>Review</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {prs.map((pr) => (
            <tr key={pr.id}>
              <td className="mono">{pr.adoPrId}</td>
              <td>
                {pr.title}
                {pr.isDraft && <span className="ado-tag draft">Draft</span>}
                {isMine(pr, myIdentity) && <span className="mine-badge">Mine</span>}
              </td>
              <td>{pr.author}</td>
              <td className="mono small">
                {pr.sourceBranch} → {pr.targetBranch}
              </td>
              <td className="small ado-activity">
                <span className="ado-stat" title="Unresolved / total comment threads">
                  💬 {pr.unresolvedCommentCount} / {pr.commentCount}
                </span>
                <span
                  className="ado-stat"
                  title={`${pr.approvals} approved of ${pr.reviewerCount} who voted`}
                >
                  ✅ {pr.approvals}
                </span>
              </td>
              <td>
                <div className="review-cell">
                  <ReviewBadge pr={pr} />
                  <select
                    className="mini-status-select"
                    title="Set BotSpector review status"
                    value={
                      ['not_reviewed', 'in_progress', 'reviewed'].includes(pr.reviewStatus)
                        ? pr.reviewStatus
                        : ''
                    }
                    onChange={(e) => onStatus(pr.id, e.target.value as ReviewStatus)}
                  >
                    {!['not_reviewed', 'in_progress', 'reviewed'].includes(pr.reviewStatus) && (
                      <option value="" disabled>
                        —
                      </option>
                    )}
                    <option value="not_reviewed">Not reviewed</option>
                    <option value="in_progress">In progress</option>
                    <option value="reviewed">Reviewed</option>
                  </select>
                  {pr.commentReplies > 0 && (
                    <span className="reply-badge" title="New replies on your posted comments">
                      💬 {pr.commentReplies}
                    </span>
                  )}
                </div>
              </td>
              <td className="row-actions">
                <button className="btn primary" onClick={() => onOpen(pr.id)}>
                  Open
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

function FilterToggle({
  label,
  active,
  onClick
}: {
  label: string
  active: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button className={active ? 'filter-chip active' : 'filter-chip'} onClick={onClick}>
      {label}
    </button>
  )
}

function ReviewBadge({ pr }: { pr: PullRequest }): JSX.Element {
  if (isStale(pr)) {
    return <span className="review-badge stale">Changes since review</span>
  }

  const map: Record<PullRequest['reviewStatus'], string> = {
    not_reviewed: 'Not reviewed',
    reviewing: 'Reviewing…',
    review_pending: 'Review pending',
    in_progress: 'In progress',
    reviewed: 'Reviewed',
    error: 'Error'
  }
  return <span className={`review-badge ${pr.reviewStatus}`}>{map[pr.reviewStatus]}</span>
}
