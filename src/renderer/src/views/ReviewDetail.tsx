import { useCallback, useEffect, useState } from 'react'
import type {
  CopilotModel,
  Finding,
  FindingStatus,
  PostedComment,
  PrAdoDetails,
  PinnedChange,
  PullRequest,
  Review,
  ReviewStatus,
  ReviewSummary,
  Skill
} from '../../../shared/types'
import { FINDING_BUCKETS } from '../../../shared/types'
import { FindingCard } from '../components/FindingCard'
import { Markdown } from '../components/Markdown'
import { FilesTab, type FileRequest } from './FilesTab'
import { ChatTab } from './ChatTab'
import { AdoCommentsTab } from './AdoCommentsTab'

interface Props {
  prId: number
  defaultModel: string
  onBack: () => void
}

// localStorage keys for the remembered review-dialog choice (skill + models),
// so a preference carries across PRs until the user resets it.
const REVIEW_MODELS_KEY = 'botspector.reviewModels'
const REVIEW_SKILL_KEY = 'botspector.reviewSkill'

type StatusFilter = 'all' | FindingStatus
type Tab = 'review' | 'files' | 'comments' | 'chat'

export function ReviewDetail({ prId, defaultModel, onBack }: Props): JSX.Element {
  const [pr, setPr] = useState<PullRequest | null>(null)
  const [review, setReview] = useState<Review | null>(null)
  const [reviewHistory, setReviewHistory] = useState<ReviewSummary[]>([])
  const [postedComments, setPostedComments] = useState<PostedComment[]>([])
  const [adoDetails, setAdoDetails] = useState<PrAdoDetails | null>(null)
  const [models, setModels] = useState<CopilotModel[]>([])
  const [skills, setSkills] = useState<Skill[]>([])
  const [selectedSkillId, setSelectedSkillId] = useState<string>(() => {
    try {
      return localStorage.getItem(REVIEW_SKILL_KEY) || 'general'
    } catch {
      return 'general'
    }
  })
  const [reviewing, setReviewing] = useState(false)
  const [refreshingPr, setRefreshingPr] = useState(false)
  const [progress, setProgress] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [explanation, setExplanation] = useState<string | null>(null)
  const [explaining, setExplaining] = useState(false)
  const [explainProgress, setExplainProgress] = useState('')
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [tab, setTab] = useState<Tab>('review')
  const [fileRequest, setFileRequest] = useState<FileRequest | null>(null)
  const [pinnedChange, setPinnedChange] = useState<PinnedChange | null>(null)
  const [reviewDialogOpen, setReviewDialogOpen] = useState(false)
  const [dialogModels, setDialogModels] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem(REVIEW_MODELS_KEY)
      if (saved) {
        const ids = JSON.parse(saved) as string[]
        if (Array.isArray(ids)) return new Set(ids.filter((id) => typeof id === 'string'))
      }
    } catch {
      // ignore malformed storage
    }
    return new Set()
  })

  const openInFiles = useCallback((path: string, line: number | null) => {
    setTab('files')
    setFileRequest({ path, line, nonce: Date.now() })
  }, [])

  const chatAboutChange = useCallback((path: string) => {
    setPinnedChange({ kind: 'change', path, nonce: Date.now() })
    setTab('chat')
  }, [])

  const chatAboutFinding = useCallback((finding: Finding) => {
    setPinnedChange({
      kind: 'finding',
      findingId: finding.id,
      publicId: finding.publicId,
      title: finding.title,
      filePath: finding.filePath,
      line: finding.line,
      nonce: Date.now()
    })
    setTab('chat')
  }, [])

  const load = useCallback(async () => {
    const [prRes, reviewRes, postedRes, historyRes] = await Promise.all([
      window.api.getPullRequest(prId),
      window.api.getReview(prId),
      window.api.getPostedComments(prId),
      window.api.getReviewHistory(prId)
    ])
    if (prRes.ok) setPr(prRes.data)
    if (postedRes.ok) setPostedComments(postedRes.data)
    if (historyRes.ok) setReviewHistory(historyRes.data)
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

  // Load the available Copilot models so the review dialog can list them.
  useEffect(() => {
    let active = true
    void window.api.copilotListModels().then((res) => {
      if (active && res.ok) setModels(res.data)
    })
    return () => {
      active = false
    }
  }, [])

  // Load the available review skills so the user can pick one to focus this run.
  useEffect(() => {
    let active = true
    void window.api.listSkills().then((res) => {
      if (active && res.ok) setSkills(res.data)
    })
    return () => {
      active = false
    }
  }, [])

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

  // The agentic "Explain this PR" action reports progress as it reads the
  // changed files; surface it next to the button.
  useEffect(() => {
    const unsub = window.api.onExplainProgress((p) => {
      if (p.prId === prId) setExplainProgress(p.message)
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

  async function runReviewFromDialog(): Promise<void> {
    const chosen = Array.from(dialogModels)
    if (chosen.length === 0) return
    // Remember this choice so it carries across PRs (reset restores defaults).
    try {
      localStorage.setItem(REVIEW_MODELS_KEY, JSON.stringify(chosen))
      localStorage.setItem(REVIEW_SKILL_KEY, selectedSkillId)
    } catch {
      // ignore storage failures
    }
    setReviewDialogOpen(false)
    setReviewing(true)
    setError(null)
    const isPanel = chosen.length > 1
    setProgress(
      isPanel
        ? `Starting panel review (${chosen.length} reviewers)…`
        : 'Starting…'
    )
    const res = isPanel
      ? await window.api.reviewPullRequestPanel(prId, chosen, selectedSkillId)
      : await window.api.reviewPullRequest(prId, chosen[0], selectedSkillId)
    setReviewing(false)
    setProgress('')
    if (res.ok) setReview(res.data)
    else setError(res.error)
    // Reload so the review-history section reflects every new pass.
    void load()
  }

  // Open the review dialog. Drops any remembered models that are no longer
  // available and, if nothing is left, seeds with the default model.
  function openReviewDialog(): void {
    setDialogModels((prev) => {
      const available = new Set(models.map((m) => m.id))
      const kept = new Set(Array.from(prev).filter((id) => available.has(id)))
      if (kept.size > 0) return kept
      return new Set(defaultModel ? [defaultModel] : [])
    })
    setReviewDialogOpen(true)
  }

  function toggleDialogModel(id: string): void {
    setDialogModels((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Restore the dialog to the app defaults: the general skill and the default
  // model, clearing any remembered choice.
  function resetReviewDialog(): void {
    setSelectedSkillId('general')
    setDialogModels(new Set(defaultModel ? [defaultModel] : []))
    try {
      localStorage.removeItem(REVIEW_MODELS_KEY)
      localStorage.removeItem(REVIEW_SKILL_KEY)
    } catch {
      // ignore storage failures
    }
  }

  // Force-reload the PR summary and live Azure DevOps details. Useful when the
  // author has edited the title/description or updated votes and the app is
  // still showing the cached version.
  async function refreshPr(): Promise<void> {
    if (refreshingPr) return
    setRefreshingPr(true)
    setError(null)
    const [prRes, adoRes] = await Promise.all([
      window.api.refreshPullRequest(prId),
      window.api.getAdoDetails(prId)
    ])
    setRefreshingPr(false)
    if (prRes.ok) {
      if (prRes.data) setPr(prRes.data)
    } else setError(prRes.error)
    if (adoRes.ok) setAdoDetails(adoRes.data)
  }

  async function explainPr(): Promise<void> {
    setExplaining(true)
    setError(null)
    setExplainProgress('Starting…')
    const res = await window.api.explainPrDescription(prId, defaultModel)
    setExplaining(false)
    setExplainProgress('')
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
        <button
          className="btn"
          onClick={() => void refreshPr()}
          disabled={refreshingPr}
          title="Reload this PR from Azure DevOps (title, description, votes, draft, head commit)"
        >
          {refreshingPr ? (
            <>
              <span className="spinner" /> Refreshing…
            </>
          ) : (
            '↻ Refresh'
          )}
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
        <div className="spacer" />
        <ReviewDialog
          open={reviewDialogOpen}
          onOpen={openReviewDialog}
          onClose={() => setReviewDialogOpen(false)}
          models={models}
          defaultModel={defaultModel}
          selectedModels={dialogModels}
          onToggleModel={toggleDialogModel}
          skills={skills}
          selectedSkillId={selectedSkillId}
          onSkillChange={setSelectedSkillId}
          reviewedModels={new Set(reviewHistory.map((r) => r.model))}
          hasReview={!!review}
          isReviewing={isReviewing}
          onRun={runReviewFromDialog}
          onReset={resetReviewDialog}
        />
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
              <div className="pr-description-head-actions">
                {explaining && explainProgress && (
                  <span className="muted small explain-progress">
                    <span className="spinner" /> {explainProgress}
                  </span>
                )}
                <button
                  className="btn"
                  onClick={explainPr}
                  disabled={explaining}
                  title="Explain this PR from its actual code changes (the description is only used as a hint)"
                >
                  {explaining ? 'Explaining…' : 'Explain this PR'}
                </button>
              </div>
            </div>
            <div className="pr-description">
              {pr.description.trim() ? (
                <div className="markdown">
                  <Markdown>{pr.description}</Markdown>
                </div>
              ) : (
                <span className="muted">No description.</span>
              )}
            </div>
            {explanation && (
              <div className="explanation">
                <strong>In plain language</strong>
                <div className="markdown">
                  <Markdown>{explanation}</Markdown>
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
          className={tab === 'comments' ? 'tab active' : 'tab'}
          onClick={() => setTab('comments')}
        >
          Comments
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
        <FilesTab prId={prId} model={defaultModel} request={fileRequest} onChatAbout={chatAboutChange} />
      </div>

      {tab === 'comments' && (
        <AdoCommentsTab
          prId={prId}
          model={defaultModel}
          onOpenInFiles={openInFiles}
          onFindingCreated={load}
        />
      )}

      {/* Chat tab stays mounted so its conversation survives tab switches. */}
      <div style={{ display: tab === 'chat' ? 'block' : 'none' }}>
        <ChatTab
          prId={prId}
          model={defaultModel}
          pinnedChange={pinnedChange}
          onClearPinnedChange={() => setPinnedChange(null)}
          onFindingCreated={load}
        />
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

          {reviewHistory.length > 0 && (
            <ReviewHistory history={reviewHistory} headCommit={pr?.headCommit ?? ''} />
          )}

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
                    model={defaultModel}
                    onChanged={load}
                    onOpenInFiles={openInFiles}
                    onChatAbout={chatAboutFinding}
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

// A history of every model that has reviewed this PR, showing which findings it
// raised itself and which existing findings it agreed with (+1'd).
function ReviewHistory({
  history,
  headCommit
}: {
  history: ReviewSummary[]
  headCommit: string
}): JSX.Element {
  return (
    <details className="review-history">
      <summary>
        Review history <span className="count">{history.length}</span>
      </summary>
      <div className="review-history-body">
        {history.map((r) => {
          const commit = r.reviewedCommit ?? ''
          const onOldCommit = !!commit && !!headCommit && commit !== headCommit
          return (
            <div key={r.id} className="review-history-row">
              <div className="review-history-head">
                <span className="rh-model mono">{r.model}</span>
                <span className="muted small">{new Date(r.createdAt).toLocaleString()}</span>
                {commit ? (
                  <span
                    className={`rh-commit mono small ${onOldCommit ? 'stale' : ''}`}
                    title={
                      onOldCommit
                        ? `Reviewed on ${commit} — the PR has since moved to ${headCommit}`
                        : `Reviewed on ${commit} (current head)`
                    }
                  >
                    @{commit.slice(0, 8)}
                    {onOldCommit ? ' · previous commit' : ''}
                  </span>
                ) : (
                  <span className="muted small">commit n/a</span>
                )}
              </div>
              <div className="review-history-findings small">
                <span className="rh-label">Raised:</span>
                {r.createdFindings.length > 0 ? (
                  r.createdFindings.map((id) => (
                    <span key={id} className="rh-chip created mono">
                      {id}
                    </span>
                  ))
                ) : (
                  <span className="muted">none</span>
                )}
                <span className="rh-label">+1&apos;d:</span>
                {r.contributedFindings.length > 0 ? (
                  r.contributedFindings.map((id) => (
                    <span key={id} className="rh-chip plusone mono">
                      {id}
                    </span>
                  ))
                ) : (
                  <span className="muted">none</span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </details>
  )
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

// The unified "Review this PR" control: a primary button that opens a dialog
// to choose a skill and one or more models. Selecting a single model runs a
// normal review; selecting several runs a panel review where each model's
// findings stack — overlaps become "+1" contributions, unique issues get added.
function ReviewDialog({
  open,
  onOpen,
  onClose,
  models,
  defaultModel,
  selectedModels,
  onToggleModel,
  skills,
  selectedSkillId,
  onSkillChange,
  reviewedModels,
  hasReview,
  isReviewing,
  onRun,
  onReset
}: {
  open: boolean
  onOpen: () => void
  onClose: () => void
  models: CopilotModel[]
  defaultModel: string
  selectedModels: Set<string>
  onToggleModel: (id: string) => void
  skills: Skill[]
  selectedSkillId: string
  onSkillChange: (id: string) => void
  reviewedModels: Set<string>
  hasReview: boolean
  isReviewing: boolean
  onRun: () => Promise<void> | void
  onReset: () => void
}): JSX.Element {
  const count = selectedModels.size
  const activeSkill = skills.find((s) => s.id === selectedSkillId)
  return (
    <div className="panel-review-control">
      <button
        className="btn primary"
        onClick={onOpen}
        disabled={isReviewing}
        title="Choose a skill and one or more models, then run the review."
      >
        {isReviewing ? (
          <>
            <span className="spinner" /> Reviewing…
          </>
        ) : hasReview ? (
          'Re-review…'
        ) : (
          'Review this PR'
        )}
      </button>
      {open && (
        <>
          <div className="panel-review-scrim" onClick={onClose} />
          <div className="panel-review-menu" onClick={(e) => e.stopPropagation()}>
            <div className="panel-review-head">
              <strong>Review this PR</strong>
              <p className="muted small">
                Pick a skill and one or more models. Several models run as a panel: overlapping
                findings become “+1” contributions on the existing ones; unique issues get added.
              </p>
            </div>

            <label className="review-dialog-field">
              <span className="muted small">Skill</span>
              <select
                className="status-select"
                value={selectedSkillId}
                onChange={(e) => onSkillChange(e.target.value)}
                disabled={skills.length === 0}
              >
                {skills.length === 0 && <option value={selectedSkillId}>{selectedSkillId}</option>}
                {skills.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              {activeSkill && <span className="muted small">{activeSkill.description}</span>}
            </label>

            <div className="review-dialog-field">
              <span className="muted small">Models</span>
              <div className="panel-review-list">
                {models.length === 0 && (
                  <div className="muted small">No models available. Check Copilot in Settings.</div>
                )}
                {models.map((m) => {
                  const already = reviewedModels.has(m.id)
                  const checked = selectedModels.has(m.id)
                  return (
                    <label key={m.id} className="panel-review-item">
                      <input type="checkbox" checked={checked} onChange={() => onToggleModel(m.id)} />
                      <span className="panel-review-item-name">
                        {m.name}
                        {m.id === defaultModel ? ' (default)' : ''}
                      </span>
                      {already && (
                        <span
                          className="panel-review-tag"
                          title="This model has already reviewed this PR — running it again will re-check its own findings and re-consider new issues."
                        >
                          already reviewed
                        </span>
                      )}
                    </label>
                  )
                })}
              </div>
            </div>

            <div className="panel-review-actions">
              <button className="btn subtle small-btn" onClick={onReset}>
                Reset to default
              </button>
              <div className="spacer" />
              <button className="btn subtle small-btn" onClick={onClose}>
                Cancel
              </button>
              <button
                className="btn primary small-btn"
                onClick={() => void onRun()}
                disabled={count === 0}
              >
                {count > 1 ? `Run panel (${count})` : 'Run review'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
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
