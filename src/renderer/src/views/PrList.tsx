import { useCallback, useEffect, useRef, useState } from 'react'
import type { PullRequest, ReviewStatus } from '../../../shared/types'

interface Props {
  onOpen: (prId: number) => void
  myIdentity: string
}

// How often to silently refresh the PR list (and head commits) in the background.
const AUTO_REFRESH_MS = 3 * 60 * 1000

interface Filters {
  showMine: boolean
  showNotMine: boolean
  excludeDrafts: boolean
  approved1: boolean
  approved2: boolean
  openComments: boolean
  showDeclined: boolean
  showApproved: boolean
}

const DEFAULT_FILTERS: Filters = {
  showMine: true,
  showNotMine: true,
  excludeDrafts: false,
  approved1: false,
  approved2: false,
  openComments: false,
  showDeclined: false,
  showApproved: false
}

const FILTERS_KEY = 'botspector.prFilters'

function loadFilters(): Filters {
  try {
    const raw = localStorage.getItem(FILTERS_KEY)
    if (raw) {
      const stored = JSON.parse(raw) as Partial<Filters> & { excludeMine?: boolean }
      const merged: Filters = { ...DEFAULT_FILTERS, ...stored }
      // Migrate the old single "Exclude mine" toggle to the Mine/Not mine pair.
      if (stored.excludeMine !== undefined && stored.showNotMine === undefined) {
        merged.showMine = !stored.excludeMine
        merged.showNotMine = true
      }
      return merged
    }
  } catch {
    // ignore malformed stored value
  }
  // Migrate the very old standalone "exclude mine" preference.
  const excludeMine = localStorage.getItem('botspector.excludeMine') === 'true'
  return { ...DEFAULT_FILTERS, showMine: !excludeMine }
}

function matchesFilters(pr: PullRequest, filters: Filters, myIdentity: string): boolean {
  // Author filter: when neither (or both) option is ticked, show everyone.
  if (filters.showMine || filters.showNotMine) {
    const mine = isMine(pr, myIdentity)
    if (mine && !filters.showMine) return false
    if (!mine && !filters.showNotMine) return false
  }
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

// A PR you've explicitly chosen not to review; parked out of the main queue.
function isDeclined(pr: PullRequest): boolean {
  return pr.reviewStatus === 'declined'
}

// A PR you've already voted "approve" (or "approve with suggestions") on in
// Azure DevOps — done from your side, so parked out of the actionable queues.
function isApprovedByMe(pr: PullRequest): boolean {
  return pr.myVote >= 5
}

// True when the source branch has moved on since we captured the reviewed commit.
function commitChanged(pr: PullRequest): boolean {
  return !!pr.reviewedCommit && !!pr.headCommit && pr.reviewedCommit !== pr.headCommit
}

// The AI has reviewed the PR but you haven't triaged it yet, and new commits have
// landed since — the pending findings may no longer match the current code.
function isReviewStale(pr: PullRequest): boolean {
  return pr.reviewStatus === 'review_pending' && commitChanged(pr)
}

// A triaged/clean PR that has changed since we reviewed it (needs a re-review).
function isStale(pr: PullRequest): boolean {
  return (pr.reviewStatus === 'reviewed' || pr.reviewStatus === 'in_progress') && commitChanged(pr)
}

// A stale PR is ready for another look once the author has engaged with every
// comment we posted (reply or resolved thread) — or we posted no comments at
// all. Otherwise we're still waiting on them and it's only "changed since review".
function isReadyForReReview(pr: PullRequest): boolean {
  return pr.unaddressedComments === 0
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
  // Guards against overlapping refreshes (interval + focus + visibility can all
  // fire at once); without it, bgBusy could get stuck showing "Updating…".
  const refreshing = useRef(false)

  // Persist filter selections across sessions.
  useEffect(() => {
    localStorage.setItem(FILTERS_KEY, JSON.stringify(filters))
  }, [filters])

  const toggleFilter = (key: keyof Filters): void => setFilters((f) => ({ ...f, [key]: !f[key] }))

  const refresh = useCallback(async (silent = false): Promise<void> => {
    if (refreshing.current) return
    refreshing.current = true
    if (silent) setBgBusy(true)
    else setLoading(true)
    try {
      const res = await window.api.listPullRequests()
      if (res.ok) {
        setPrs(res.data)
        setError(null)
        setLastRefreshed(new Date())
      } else if (!silent) {
        setError(res.error)
      }
    } catch (e) {
      if (!silent) setError((e as Error).message)
    } finally {
      refreshing.current = false
      if (silent) setBgBusy(false)
      else setLoading(false)
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
  // Declined PRs are parked in their own (collapsible) section and kept out of
  // every actionable queue below.
  const declined = visible.filter((pr) => isDeclined(pr)).sort(byOldest)
  const triageable = visible.filter((pr) => !isDeclined(pr))
  const mine = triageable.filter((pr) => isMine(pr, myIdentity)).sort(byOldest)
  // PRs we've already approved in Azure DevOps are done from our side, so keep
  // them out of the actionable queue (ADO resets our vote if they change again).
  // They're parked in their own (collapsible) "Approved by you" section so you
  // can still find them via the "Show approved" filter.
  const approvedByMe = triageable
    .filter((pr) => !isMine(pr, myIdentity) && isApprovedByMe(pr))
    .sort(byOldest)
  const others = triageable.filter((pr) => !isMine(pr, myIdentity) && !isApprovedByMe(pr))
  // A stale PR is "ready for re-review" once the author has engaged with every
  // comment we posted (a reply or a resolved thread), or we posted none. Until
  // then it's just "changed since review" and shouldn't demand our attention.
  // AI-reviewed but not yet triaged, and the code changed underneath: its pending
  // findings are stale and worth a fresh look before you spend time triaging.
  const reviewStale = others.filter((pr) => isReviewStale(pr)).sort(byOldest)
  const readyForReReview = others
    .filter((pr) => isStale(pr) && isReadyForReReview(pr))
    .sort(byOldest)
  const changedSinceReview = others
    .filter((pr) => isStale(pr) && !isReadyForReReview(pr))
    .sort(byOldest)
  const reviewPending = others
    .filter((pr) => !isReviewStale(pr) && pr.reviewStatus === 'review_pending')
    .sort(byOldest)
  const inProgress = others
    .filter((pr) => !isStale(pr) && pr.reviewStatus === 'in_progress')
    .sort(byOldest)
  const queue = others
    .filter(
      (pr) =>
        !isStale(pr) &&
        !isReviewStale(pr) &&
        pr.reviewStatus !== 'review_pending' &&
        pr.reviewStatus !== 'in_progress'
    )
    .sort(byUnreviewedThenOldest)

  return (
    <div className="prlist">
      <div className="prlist-header">
        <h1>Review Queue</h1>
        <div className="prlist-actions">
          {lastRefreshed ? (
            <span className="muted small">
              Updated {lastRefreshed.toLocaleTimeString()}
              {bgBusy && ' · Updating…'}
            </span>
          ) : (
            bgBusy && <span className="muted small">Updating…</span>
          )}
          <button className="btn" onClick={() => refresh()} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="pr-filter-bar">
        <span className="muted small">Filter</span>
        {myIdentity.trim() && (
          <FilterDropdown
            label="Author"
            items={[
              { label: 'Mine', active: filters.showMine, onToggle: () => toggleFilter('showMine') },
              {
                label: 'Not mine',
                active: filters.showNotMine,
                onToggle: () => toggleFilter('showNotMine')
              }
            ]}
          />
        )}
        <FilterDropdown
          label="Approvals"
          items={[
            {
              label: '1+ approval',
              active: filters.approved1,
              onToggle: () => toggleFilter('approved1')
            },
            {
              label: '2+ approvals',
              active: filters.approved2,
              onToggle: () => toggleFilter('approved2')
            }
          ]}
        />
        <FilterDropdown
          label="Status"
          items={[
            {
              label: 'Exclude drafts',
              active: filters.excludeDrafts,
              onToggle: () => toggleFilter('excludeDrafts')
            },
            {
              label: 'Open comments',
              active: filters.openComments,
              onToggle: () => toggleFilter('openComments')
            }
          ]}
        />
        <FilterDropdown
          label="Show"
          items={[
            {
              label: `Approved${approvedByMe.length ? ` (${approvedByMe.length})` : ''}`,
              active: filters.showApproved,
              onToggle: () => toggleFilter('showApproved')
            },
            {
              label: `Declined${declined.length ? ` (${declined.length})` : ''}`,
              active: filters.showDeclined,
              onToggle: () => toggleFilter('showDeclined')
            }
          ]}
        />
      </div>

      {error && <div className="banner err">{error}</div>}

      {!loading &&
        !bgBusy &&
        triageable.length === 0 &&
        (!filters.showDeclined || declined.length === 0) &&
        !error && (
          <div className="empty">
            <p>
              Nothing to review here 👀 — try Refresh, adjust the filters, or check your Azure
              DevOps settings.
            </p>
          </div>
        )}

      {readyForReReview.length > 0 && (
        <PrSection
          title="Ready for re-review"
          hint="Changed and the author has addressed your comments"
          prs={readyForReReview}
          myIdentity={myIdentity}
          onOpen={onOpen}
          onStatus={changeStatus}
        />
      )}
      {reviewStale.length > 0 && (
        <PrSection
          title="Review stale"
          hint="AI reviewed, but new commits landed before you triaged it"
          prs={reviewStale}
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
      {changedSinceReview.length > 0 && (
        <PrSection
          title="Changed since review"
          hint="Changed, but still waiting on your comments to be addressed"
          prs={changedSinceReview}
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
      {filters.showApproved && approvedByMe.length > 0 && (
        <PrSection
          title="Approved by you"
          hint="You've already approved these in Azure DevOps"
          prs={approvedByMe}
          myIdentity={myIdentity}
          onOpen={onOpen}
          onStatus={changeStatus}
        />
      )}
      {filters.showDeclined && declined.length > 0 && (
        <PrSection
          title="Declined"
          hint="You chose not to review these"
          prs={declined}
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
      <table className="table queue-table">
        <colgroup>
          <col className="col-num" />
          <col className="col-title" />
          <col className="col-author" />
          <col className="col-branch" />
          <col className="col-ado" />
          <col className="col-review" />
          <col className="col-actions" />
        </colgroup>
        <thead>
          <tr>
            <th>#</th>
            <th>Title</th>
            <th>Author</th>
            <th className="cell-branch">Branch</th>
            <th className="cell-ado">Azure DevOps</th>
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
              <td className="mono small cell-branch">
                {pr.sourceBranch} → {pr.targetBranch}
              </td>
              <td className="small ado-activity cell-ado">
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
                      ['not_reviewed', 'in_progress', 'reviewed', 'declined'].includes(
                        pr.reviewStatus
                      )
                        ? pr.reviewStatus
                        : ''
                    }
                    onChange={(e) => onStatus(pr.id, e.target.value as ReviewStatus)}
                  >
                    {!['not_reviewed', 'in_progress', 'reviewed', 'declined'].includes(
                      pr.reviewStatus
                    ) && (
                      <option value="" disabled>
                        —
                      </option>
                    )}
                    <option value="not_reviewed">Not reviewed</option>
                    <option value="in_progress">In progress</option>
                    <option value="reviewed">Reviewed</option>
                    <option value="declined">Decline to review</option>
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

function FilterDropdown({
  label,
  items
}: {
  label: string
  items: { label: string; active: boolean; onToggle: () => void }[]
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const activeCount = items.filter((i) => i.active).length

  // Close the menu when clicking anywhere outside it.
  useEffect(() => {
    if (!open) return
    const onDocMouseDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [open])

  return (
    <div className="filter-dropdown" ref={ref}>
      <button
        className={activeCount ? 'filter-chip active' : 'filter-chip'}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
        {activeCount > 0 && <span className="filter-chip-count">{activeCount}</span>}
        <span className="filter-caret">▾</span>
      </button>
      {open && (
        <div className="filter-menu">
          {items.map((item) => (
            <label key={item.label} className="filter-menu-item">
              <input type="checkbox" checked={item.active} onChange={item.onToggle} />
              <span>{item.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

function ReviewBadge({ pr }: { pr: PullRequest }): JSX.Element {
  if (isDeclined(pr)) {
    return <span className="review-badge declined">Declined</span>
  }
  if (isReviewStale(pr)) {
    return <span className="review-badge stale">Review stale</span>
  }
  if (isStale(pr)) {
    return isReadyForReReview(pr) ? (
      <span className="review-badge ready-rereview">Ready for re-review</span>
    ) : (
      <span className="review-badge stale">Changed since review</span>
    )
  }

  const map: Record<PullRequest['reviewStatus'], string> = {
    not_reviewed: 'Not reviewed',
    reviewing: 'Reviewing…',
    review_pending: 'Review pending',
    in_progress: 'In progress',
    reviewed: 'Reviewed',
    declined: 'Declined',
    error: 'Error'
  }
  return <span className={`review-badge ${pr.reviewStatus}`}>{map[pr.reviewStatus]}</span>
}
