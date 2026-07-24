import { useCallback, useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type {
  CopilotModel,
  FindingStatus,
  PostedComment,
  PrAdoDetails,
  PinnedChange,
  PullRequest,
  Review,
  ReviewStatus
} from '../../../shared/types'
import { FINDING_BUCKETS } from '../../../shared/types'
import { FindingCard } from '../components/FindingCard'
import { FilesTab, type FileRequest } from './FilesTab'
import { ChatTab } from './ChatTab'

interface Props {
  prId: number
  defaultModel: string
  onBack: () => void
}

type StatusFilter = 'all' | FindingStatus
type Tab = 'review' | 'files' | 'chat'

export function ReviewDetail({ prId, defaultModel, onBack }: Props): JSX.Element {
  const [pr, setPr] = useState<PullRequest | null>(null)
  const [review, setReview] = useState<Review | null>(null)
  const [postedComments, setPostedComments] = useState<PostedComment[]>([])
  const [adoDetails, setAdoDetails] = useState<PrAdoDetails | null>(null)
  const [models, setModels] = useState<CopilotModel[]>([])
  const [selectedModel, setSelectedModel] = useState<string>(defaultModel)
  const [reviewing, setReviewing] = useState(false)
  const [progress, setProgress] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [explanation, setExplanation] = useState<string | null>(null)
  const [explaining, setExplaining] = useState(false)
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [tab, setTab] = useState<Tab>('review')
  const [fileRequest, setFileRequest] = useState<FileRequest | null>(null)
  const [pinnedChange, setPinnedChange] = useState<PinnedChange | null>(null)

  const openInFiles = useCallback((path: string, line: number | null) => {
    setTab('files')
    setFileRequest({ path, line, nonce: Date.now() })
  }, [])

  const chatAboutChange = useCallback((path: string) => {
    setPinnedChange({ path, nonce: Date.now() })
    setTab('chat')
  }, [])

  const load = useCallback(async () => {
    const [prRes, reviewRes, postedRes] = await Promise.all([
      window.api.getPullRequest(prId),
      window.api.getReview(prId),
      window.api.getPostedComments(prId)
    ])
    if (prRes.ok) setPr(prRes.data)
    if (postedRes.ok) setPostedComments(postedRes.data)
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

  // Load the available Copilot models for the per-PR model selector. Default to
  // the Settings model; fall back to it if listing fails.
  useEffect(() => {
    setSelectedModel((m) => m || defaultModel)
    let active = true
    void window.api.copilotListModels().then((res) => {
      if (active && res.ok) setModels(res.data)
    })
    return () => {
      active = false
    }
  }, [defaultModel])

  // Fetch live Azure DevOps state (status, draft, reviewer votes) separately so
  // its network latency doesn't hold up the main review load.
  useEffect(() => {
    let active = true
    void window.api.getAdoDetails(prId).then((res) => {
      if (active && res.ok) setAdoDetails(res.data)
    })
    return () => {
      active = false
    }
  }, [prId])

  useEffect(() => {
    const unsub = window.api.onReviewProgress((p) => {
      if (p.prId === prId) setProgress(p.message)
    })
    return unsub
  }, [prId])

  // A review runs in the main process, so it keeps going even if we navigate
  // away and remount. Listen for its completion to reload the finished review.
  useEffect(() => {
    const unsub = window.api.onReviewDone((p) => {
      if (p.prId !== prId) return
      setReviewing(false)
      setProgress('')
      void load()
    })
    return unsub
  }, [prId, load])

  async function runReview(): Promise<void> {
    setReviewing(true)
    setError(null)
    setProgress('Starting…')
    const res = await window.api.reviewPullRequest(prId, selectedModel)
    setReviewing(false)
    setProgress('')
    if (res.ok) setReview(res.data)
    else setError(res.error)
  }

  async function explainPr(): Promise<void> {
    setExplaining(true)
    setError(null)
    const res = await window.api.explainPrDescription(prId, selectedModel)
    setExplaining(false)
    if (res.ok) setExplanation(res.data)
    else setError(res.error)
  }

  async function changeStatus(status: ReviewStatus): Promise<void> {
    setError(null)
    const res = await window.api.setReviewStatus(prId, status)
    if (res.ok) setPr(res.data)
    else setError(res.error)
  }

  async function castVote(vote: number): Promise<void> {
    setError(null)
    const res = await window.api.setVote(prId, vote)
    if (res.ok) {
      setAdoDetails(res.data)
      // Approving in ADO flips the BotSpector status to reviewed; reflect it.
      void load()
    } else setError(res.error)
  }

  async function changeAdoStatus(status: 'active' | 'abandoned'): Promise<void> {
    setError(null)
    const res = await window.api.setAdoStatus(prId, status)
    if (res.ok) setAdoDetails(res.data)
    else setError(res.error)
  }

  async function changeDraft(isDraft: boolean): Promise<void> {
    setError(null)
    const res = await window.api.setDraft(prId, isDraft)
    if (res.ok) setAdoDetails(res.data)
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

  // Comments we posted in earlier reviews whose finding is no longer part of the
  // current review (e.g. after a re-review). These would otherwise be invisible,
  // so surface them with their Azure DevOps thread status and conversation.
  const currentThreadIds = new Set(
    allFindings.map((f) => f.comment?.adoThreadId).filter((id): id is number => id != null)
  )
  const priorComments = postedComments.filter((c) => !currentThreadIds.has(c.adoThreadId))

  // Reflect an in-progress review even after remounting: the local flag is lost
  // on navigation, but the PR's persisted status tells us it's still running.
  const isReviewing = reviewing || pr?.reviewStatus === 'reviewing'

  return (
    <div className="review">
      <div className="review-header">
        <button className="btn" onClick={onBack}>
          ← Back
        </button>
        <div className="review-status-control">
          <span className="muted small">Status</span>
          {isReviewing ? (
            <span className="review-badge reviewing">Reviewing…</span>
          ) : (
            <select
              className="status-select"
              value={
                pr && ['not_reviewed', 'in_progress', 'reviewed', 'declined'].includes(pr.reviewStatus)
                  ? pr.reviewStatus
                  : ''
              }
              onChange={(e) => void changeStatus(e.target.value as ReviewStatus)}
            >
              {pr && !['not_reviewed', 'in_progress', 'reviewed', 'declined'].includes(pr.reviewStatus) && (
                <option value="" disabled>
                  {pr.reviewStatus === 'error'
                    ? 'Error'
                    : pr.reviewStatus === 'review_pending'
                      ? 'Review pending'
                      : '—'}
                </option>
              )}
              <option value="not_reviewed">Not reviewed</option>
              <option value="in_progress">In progress</option>
              <option value="reviewed">Reviewed</option>
              <option value="declined">Decline to review</option>
            </select>
          )}
        </div>
        <div className="review-model-control">
          <span className="muted small">Model</span>
          <select
            className="status-select"
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            disabled={isReviewing}
            title="Model used for the review and AI actions on this PR"
          >
            {!models.some((m) => m.id === selectedModel) && selectedModel && (
              <option value={selectedModel}>{selectedModel}</option>
            )}
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {m.id === defaultModel ? ' (default)' : ''}
              </option>
            ))}
          </select>
        </div>
        <button className="btn primary" onClick={runReview} disabled={isReviewing}>
          {isReviewing ? (
            <>
              <span className="spinner" /> Reviewing…
            </>
          ) : review ? (
            'Review with this model'
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

          {adoDetails && (
            <div className="ado-panel">
              <div className="ado-panel-row">
                <span className={`ado-status-badge ${adoDetails.status}`}>
                  {adoDetails.isDraft ? 'Draft' : capitalize(adoDetails.status)}
                </span>
                <span className="muted small">
                  {adoDetails.reviewers.filter((r) => r.vote >= 5).length} approved ·{' '}
                  {adoDetails.commentCount} comment{adoDetails.commentCount === 1 ? '' : 's'}
                </span>
              </div>
              <div className="ado-panel-row">
                <label className="muted small">My vote</label>
                <select
                  className="status-select"
                  value={String(adoDetails.myVote)}
                  onChange={(e) => void castVote(Number(e.target.value))}
                >
                  <option value="10">Approve</option>
                  <option value="5">Approve with suggestions</option>
                  <option value="0">No vote</option>
                  <option value="-5">Wait for author</option>
                  <option value="-10">Reject</option>
                </select>
                {adoDetails.status === 'active' && (
                  <>
                    {adoDetails.isDraft ? (
                      <button className="btn" onClick={() => void changeDraft(false)}>
                        Publish
                      </button>
                    ) : (
                      <button className="btn" onClick={() => void changeDraft(true)}>
                        Mark draft
                      </button>
                    )}
                    <button className="btn" onClick={() => void changeAdoStatus('abandoned')}>
                      Abandon
                    </button>
                  </>
                )}
                {adoDetails.status === 'abandoned' && (
                  <button className="btn" onClick={() => void changeAdoStatus('active')}>
                    Reactivate
                  </button>
                )}
              </div>
            </div>
          )}

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
              {pr.description.trim() ? (
                <div className="markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{pr.description}</ReactMarkdown>
                </div>
              ) : (
                <span className="muted">No description.</span>
              )}
            </div>
            {explanation && (
              <div className="explanation">
                <strong>In plain language</strong>
                <div className="markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{explanation}</ReactMarkdown>
                </div>
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
        <button
          className={tab === 'chat' ? 'tab active' : 'tab'}
          onClick={() => setTab('chat')}
        >
          Chat
        </button>
      </div>

      {isReviewing && (
        <div className="banner info reviewing-banner">
          <span className="spinner" />
          <span>{progress || 'Working…'}</span>
        </div>
      )}
      {error && <div className="banner err">{error}</div>}

      {/* Files tab stays mounted so it prefetches diffs in the background. */}
      <div style={{ display: tab === 'files' ? 'block' : 'none' }}>
        <FilesTab prId={prId} model={selectedModel} request={fileRequest} onChatAbout={chatAboutChange} />
      </div>

      {/* Chat tab stays mounted so its conversation survives tab switches. */}
      <div style={{ display: tab === 'chat' ? 'block' : 'none' }}>
        <ChatTab prId={prId} model={selectedModel} pinnedChange={pinnedChange} onClearPinnedChange={() => setPinnedChange(null)} />
      </div>

      {tab === 'review' && priorComments.length > 0 && (
        <PriorComments comments={priorComments} />
      )}

      {tab === 'review' && !review && !isReviewing && (
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
                  <FindingCard
                    key={f.id}
                    finding={f}
                    model={selectedModel}
                    onChanged={load}
                    onOpenInFiles={openInFiles}
                  />
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

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

// Map Azure DevOps comment-thread status values to friendly labels/styles.
function threadStateLabel(status: string | null): string {
  switch ((status ?? '').toLowerCase()) {
    case 'active':
      return 'Active'
    case 'pending':
      return 'Pending'
    case 'fixed':
      return 'Resolved'
    case 'wontfix':
      return "Won't fix"
    case 'closed':
      return 'Closed'
    case 'bydesign':
      return 'By design'
    default:
      return 'Open'
  }
}

function threadStateClass(status: string | null): string {
  switch ((status ?? '').toLowerCase()) {
    case 'active':
    case 'pending':
      return 'open'
    case 'fixed':
    case 'closed':
    case 'bydesign':
      return 'resolved'
    case 'wontfix':
      return 'wontfix'
    default:
      return 'unknown'
  }
}

function PriorComments({ comments }: { comments: PostedComment[] }): JSX.Element {
  return (
    <section className="prior-comments">
      <h2>
        Comments from previous reviews <span className="count">{comments.length}</span>
      </h2>
      <p className="muted small">
        These were posted in an earlier review. Their status and discussion below are kept in sync
        with Azure DevOps.
      </p>
      {comments.map((c) => (
        <div key={c.id} className="prior-comment">
          <div className="prior-comment-head">
            {c.findingPublicId && <span className="mono">{c.findingPublicId}</span>}
            {c.bucket && (
              <span className={`review-badge bucket-tag-${c.bucket.toLowerCase()}`}>{c.bucket}</span>
            )}
            {c.findingTitle && <span className="prior-comment-title">{c.findingTitle}</span>}
            <span className={`thread-pill ${threadStateClass(c.threadStatus)}`}>
              {threadStateLabel(c.threadStatus)}
            </span>
          </div>
          <div className="prior-comment-body">{c.commentText}</div>
          {c.replies.length > 0 && (
            <div className="replies">
              {c.replies.map((r, i) => (
                <div key={i} className="reply">
                  <div className="reply-head small">
                    <span className="reply-author">{r.author}</span>
                    {r.date && <span className="muted"> · {new Date(r.date).toLocaleString()}</span>}
                  </div>
                  <div className="reply-text">{r.text}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </section>
  )
}
