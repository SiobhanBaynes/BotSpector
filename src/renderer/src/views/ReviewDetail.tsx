import { useCallback, useEffect, useState } from 'react'
import type { FindingStatus, PullRequest, Review } from '../../../shared/types'
import { FINDING_BUCKETS } from '../../../shared/types'
import { FindingCard } from '../components/FindingCard'
import { FilesTab, type FileRequest } from './FilesTab'

interface Props {
  prId: number
  onBack: () => void
}

type StatusFilter = 'all' | FindingStatus
type Tab = 'review' | 'files'

export function ReviewDetail({ prId, onBack }: Props): JSX.Element {
  const [pr, setPr] = useState<PullRequest | null>(null)
  const [review, setReview] = useState<Review | null>(null)
  const [reviewing, setReviewing] = useState(false)
  const [progress, setProgress] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [explanation, setExplanation] = useState<string | null>(null)
  const [explaining, setExplaining] = useState(false)
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [tab, setTab] = useState<Tab>('review')
  const [fileRequest, setFileRequest] = useState<FileRequest | null>(null)

  const openInFiles = useCallback((path: string, line: number | null) => {
    setTab('files')
    setFileRequest({ path, line, nonce: Date.now() })
  }, [])

  const load = useCallback(async () => {
    const [prRes, reviewRes] = await Promise.all([
      window.api.getPullRequest(prId),
      window.api.getReview(prId)
    ])
    if (prRes.ok) setPr(prRes.data)
    if (reviewRes.ok) {
      setReview(reviewRes.data)
      // If any comments were posted, refresh their thread status in the background.
      const hasPosted = reviewRes.data?.findings.some(
        (f) => f.comment?.adoThreadId != null
      )
      if (hasPosted) {
        const refreshed = await window.api.refreshComments(prId)
        if (refreshed.ok && refreshed.data) setReview(refreshed.data)
      }
    }
  }, [prId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const unsub = window.api.onReviewProgress((p) => {
      if (p.prId === prId) setProgress(p.message)
    })
    return unsub
  }, [prId])

  async function runReview(): Promise<void> {
    setReviewing(true)
    setError(null)
    setProgress('Starting…')
    const res = await window.api.reviewPullRequest(prId)
    setReviewing(false)
    setProgress('')
    if (res.ok) setReview(res.data)
    else setError(res.error)
  }

  async function explainPr(): Promise<void> {
    setExplaining(true)
    setError(null)
    const res = await window.api.explainPrDescription(prId)
    setExplaining(false)
    if (res.ok) setExplanation(res.data)
    else setError(res.error)
  }

  const hasPostedComments = (review?.findings ?? []).some((f) => f.comment?.adoThreadId != null)

  async function refreshComments(): Promise<void> {
    const res = await window.api.refreshComments(prId)
    if (res.ok && res.data) setReview(res.data)
    else if (!res.ok) setError(res.error)
  }

  const allFindings = review?.findings ?? []
  const total = allFindings.length

  const counts: Record<FindingStatus, number> = {
    open: 0,
    accepted: 0,
    dismissed: 0,
    posted: 0
  }
  for (const f of allFindings) counts[f.status]++

  const visible = allFindings.filter((f) => filter === 'all' || f.status === filter)
  const findingsByBucket = FINDING_BUCKETS.map((bucket) => ({
    bucket,
    items: visible.filter((f) => f.bucket === bucket)
  }))

  const stale =
    !!review &&
    !!pr?.reviewedCommit &&
    !!pr?.headCommit &&
    pr.reviewedCommit !== pr.headCommit

  return (
    <div className="review">
      <div className="review-header">
        <button className="btn" onClick={onBack}>
          ← Back
        </button>
        <button className="btn primary" onClick={runReview} disabled={reviewing}>
          {reviewing ? (
            <>
              <span className="spinner" /> Reviewing…
            </>
          ) : review ? (
            'Re-review'
          ) : (
            'Review this PR'
          )}
        </button>
      </div>

      {stale && (
        <div className="banner warn">
          New commits have been pushed since this review
          {pr?.reviewedCommit ? ` (reviewed ${pr.reviewedCommit.slice(0, 8)}, now ${pr.headCommit.slice(0, 8)})` : ''}.
          Consider re-reviewing.
        </div>
      )}

      {pr && (
        <div className="pr-summary">
          <h1 className="pr-title">
            <span className="mono pr-number">#{pr.adoPrId}</span> {pr.title}
          </h1>
          <div className="pr-meta muted small">
            {pr.author} · {pr.sourceBranch} → {pr.targetBranch} ·{' '}
            <a href={pr.url} target="_blank" rel="noreferrer">
              Open in Azure DevOps
            </a>
          </div>

          <div className="pr-description-block">
            <div className="pr-description-head">
              <strong>Description</strong>
              <button
                className="btn"
                onClick={explainPr}
                disabled={explaining || !pr.description.trim()}
              >
                {explaining ? 'Explaining…' : 'Explain this PR'}
              </button>
            </div>
            <div className="pr-description">
              {pr.description.trim() ? pr.description : <span className="muted">No description.</span>}
            </div>
            {explanation && (
              <div className="explanation">
                <strong>In plain language</strong>
                <p>{explanation}</p>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="tab-bar">
        <button
          className={tab === 'review' ? 'tab active' : 'tab'}
          onClick={() => setTab('review')}
        >
          Review{total > 0 ? ` (${total})` : ''}
        </button>
        <button
          className={tab === 'files' ? 'tab active' : 'tab'}
          onClick={() => setTab('files')}
        >
          Files
        </button>
      </div>

      {reviewing && (
        <div className="banner info reviewing-banner">
          <span className="spinner" />
          <span>{progress || 'Working…'}</span>
        </div>
      )}
      {error && <div className="banner err">{error}</div>}

      {/* Files tab stays mounted so it prefetches diffs in the background. */}
      <div style={{ display: tab === 'files' ? 'block' : 'none' }}>
        <FilesTab prId={prId} request={fileRequest} />
      </div>

      {tab === 'review' && !review && !reviewing && (
        <div className="empty">
          <p>BotSpector hasn’t snooped through this PR yet. Hit “Review this PR” and let me dig in. 🕵️</p>
        </div>
      )}

      {tab === 'review' && review && (
        <>
          <div className="review-meta">
            <span>
              {total} finding{total === 1 ? '' : 's'}
            </span>
            <span className="muted">Model: {review.model}</span>
            {hasPostedComments && (
              <button className="btn small-btn" onClick={refreshComments}>
                Refresh comment status
              </button>
            )}
          </div>

          <div className="filter-bar">
            <FilterChip label="All" count={total} active={filter === 'all'} onClick={() => setFilter('all')} />
            <FilterChip label="Open" count={counts.open} active={filter === 'open'} onClick={() => setFilter('open')} />
            <FilterChip label="Accepted" count={counts.accepted} active={filter === 'accepted'} onClick={() => setFilter('accepted')} />
            <FilterChip label="Dismissed" count={counts.dismissed} active={filter === 'dismissed'} onClick={() => setFilter('dismissed')} />
            <FilterChip label="Posted" count={counts.posted} active={filter === 'posted'} onClick={() => setFilter('posted')} />
          </div>

          {findingsByBucket.map(({ bucket, items }) =>
            items.length === 0 ? null : (
              <section key={bucket} className={`bucket bucket-${bucket.toLowerCase()}`}>
                <h2>
                  {bucket} <span className="count">{items.length}</span>
                </h2>
                {items.map((f) => (
                  <FindingCard key={f.id} finding={f} onChanged={load} onOpenInFiles={openInFiles} />
                ))}
              </section>
            )
          )}

          {total === 0 && <div className="empty">Squeaky clean — BotSpector found nothing to nitpick. ✨</div>}
          {total > 0 && visible.length === 0 && (
            <div className="empty">No {filter} findings.</div>
          )}
        </>
      )}
    </div>
  )
}

function FilterChip({
  label,
  count,
  active,
  onClick
}: {
  label: string
  count: number
  active: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button className={active ? 'chip active' : 'chip'} onClick={onClick}>
      {label} <span className="chip-count">{count}</span>
    </button>
  )
}
