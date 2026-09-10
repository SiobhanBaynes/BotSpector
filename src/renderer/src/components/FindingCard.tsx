import { useEffect, useRef, useState, type FormEvent } from 'react'
import type {
  CodeSnippet,
  Finding,
  FindingStatus,
  OpenCodeCommitPreview,
  OpenCodeHandoff,
  ResolutionAssessment
} from '../../../shared/types'
import { Markdown } from './Markdown'

interface Props {
  finding: Finding
  model: string
  onChanged: () => Promise<void> | void
  onOpenInFiles?: (path: string, line: number | null) => void
  onChatAbout?: (finding: Finding) => void
  openCodeHandoff?: OpenCodeHandoff | null
  onOpenCodeChanged?: (handoff: OpenCodeHandoff, transcriptChanged?: boolean) => void
  focusNonce?: number
  currentHeadCommit?: string
}

const REFINEMENTS: Array<{ key: string; label: string; instruction: string }> = [
  { key: 'shorter', label: 'Shorter', instruction: 'Make it shorter and more concise.' },
  { key: 'clearer', label: 'Clearer', instruction: 'Make it clearer and easier to follow.' },
  {
    key: 'jargon',
    label: 'Less jargon',
    instruction: 'Reduce technical jargon and explain in plain language.'
  },
  {
    key: 'natural',
    label: 'More natural',
    instruction: 'Make it sound more natural, warm, and human.'
  }
]

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
      return 'Unknown'
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

function threadIsTerminal(status: string | null): boolean {
  return ['fixed', 'closed', 'wontfix', 'bydesign'].includes((status ?? '').toLowerCase())
}

// Azure DevOps comment-thread statuses we can set from the app.
const THREAD_STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'active', label: 'Active' },
  { value: 'pending', label: 'Pending' },
  { value: 'fixed', label: 'Resolved' },
  { value: 'wontFix', label: "Won't fix" },
  { value: 'closed', label: 'Closed' },
  { value: 'byDesign', label: 'By design' }
]

export function FindingCard({
  finding,
  model,
  onChanged,
  onOpenInFiles,
  onChatAbout,
  openCodeHandoff,
  onOpenCodeChanged,
  focusNonce,
  currentHeadCommit
}: Props): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [commentText, setCommentText] = useState(finding.comment?.draftText ?? '')
  const [customRefinement, setCustomRefinement] = useState('')
  const [code, setCode] = useState<CodeSnippet | null>(null)
  const [showCode, setShowCode] = useState(false)
  const [resolution, setResolution] = useState<ResolutionAssessment | null>(null)
  const [openCodeNote, setOpenCodeNote] = useState<string | null>(null)
  const [commitPreview, setCommitPreview] = useState<OpenCodeCommitPreview | null>(null)
  const [commitMessage, setCommitMessage] = useState('')
  const [hasUnpublishedChanges, setHasUnpublishedChanges] = useState<boolean | null>(null)
  const [checkingPublishState, setCheckingPublishState] = useState(false)
  const [resolveCommentOpen, setResolveCommentOpen] = useState(false)
  const [resolutionReply, setResolutionReply] = useState('')
  const cardRef = useRef<HTMLDivElement>(null)

  // Keep the editable text in sync when the underlying draft changes.
  useEffect(() => {
    setCommentText(finding.comment?.draftText ?? '')
  }, [finding.comment?.draftText])

  useEffect(() => {
    if (focusNonce === undefined) return
    setExpanded(true)
    const frame = requestAnimationFrame(() => {
      cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
    return () => cancelAnimationFrame(frame)
  }, [focusNonce])

  useEffect(() => {
    if ((!commitPreview && !resolveCommentOpen) || busy !== null) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setCommitPreview(null)
        setResolveCommentOpen(false)
        setError(null)
      }
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [busy, commitPreview, resolveCommentOpen])

  useEffect(() => {
    if (!expanded || !openCodeHandoff) return
    let cancelled = false
    const refresh = async (): Promise<void> => {
      setCheckingPublishState(true)
      try {
        const res = await window.api.getOpenCodeCommitPreview(finding.id)
        if (!cancelled) setHasUnpublishedChanges(res.ok ? res.data.files.length > 0 : true)
      } catch {
        if (!cancelled) setHasUnpublishedChanges(true)
      } finally {
        if (!cancelled) setCheckingPublishState(false)
      }
    }
    void refresh()
    window.addEventListener('focus', refresh)
    return () => {
      cancelled = true
      window.removeEventListener('focus', refresh)
    }
  }, [expanded, finding.id, openCodeHandoff])

  async function withBusy(key: string, fn: () => Promise<void>): Promise<void> {
    setBusy(key)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function setStatus(status: FindingStatus): Promise<void> {
    await withBusy('status', async () => {
      const res = await window.api.setFindingStatus(finding.id, status)
      if (!res.ok) throw new Error(res.error)
      await onChanged()
    })
  }

  async function explain(): Promise<void> {
    await withBusy('explain', async () => {
      setExpanded(true)
      const res = await window.api.explainFinding(finding.id, model)
      if (!res.ok) throw new Error(res.error)
      await onChanged()
    })
  }

  async function viewCode(): Promise<void> {
    if (showCode) {
      setShowCode(false)
      return
    }
    if (code) {
      setShowCode(true)
      return
    }
    await withBusy('code', async () => {
      const res = await window.api.getFindingCode(finding.id)
      if (!res.ok) throw new Error(res.error)
      setCode(res.data)
      setShowCode(true)
    })
  }

  async function draft(): Promise<void> {
    await withBusy('draft', async () => {
      const res = await window.api.draftComment(finding.id, model)
      if (!res.ok) throw new Error(res.error)
      setCommentText(res.data)
      await onChanged()
    })
  }

  async function refine(key: string, instruction: string): Promise<void> {
    await withBusy(`refine-${key}`, async () => {
      const res = await window.api.refineComment(finding.id, instruction, model)
      if (!res.ok) throw new Error(res.error)
      setCommentText(res.data)
      await onChanged()
    })
  }

  function submitCustomRefinement(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const instruction = customRefinement.trim()
    if (!instruction || busy !== null) return
    void refine('custom', instruction)
  }

  async function saveEdit(): Promise<void> {
    await withBusy('save', async () => {
      const res = await window.api.updateComment(finding.id, commentText)
      if (!res.ok) throw new Error(res.error)
      await onChanged()
    })
  }

  async function post(): Promise<void> {
    await withBusy('post', async () => {
      const res = await window.api.postComment(finding.id)
      if (!res.ok) throw new Error(res.error)
      await onChanged()
    })
  }

  async function setThreadStatus(status: string): Promise<void> {
    await withBusy('thread-status', async () => {
      const res = await window.api.setThreadStatus(finding.id, status)
      if (!res.ok) throw new Error(res.error)
      await onChanged()
    })
  }

  async function checkResolved(): Promise<void> {
    await withBusy('resolve', async () => {
      const res = await window.api.checkFindingResolved(finding.id, model)
      if (!res.ok) throw new Error(res.error)
      setResolution(res.data)
      await onChanged()
    })
  }

  async function openCode(): Promise<void> {
    await withBusy('opencode-open', async () => {
      setOpenCodeNote(null)
      const res = openCodeHandoff
        ? await window.api.reopenOpenCodeForFinding(finding.id)
        : await window.api.startOpenCodeForFinding(finding.id)
      if (!res.ok) throw new Error(res.error)
      onOpenCodeChanged?.(res.data)
      setOpenCodeNote(openCodeHandoff ? 'Reopened in Terminal' : 'Opened in Terminal')
    })
  }

  async function syncOpenCode(): Promise<void> {
    await withBusy('opencode-sync', async () => {
      setOpenCodeNote(null)
      const res = await window.api.syncOpenCodeForFinding(finding.id)
      if (!res.ok) throw new Error(res.error)
      onOpenCodeChanged?.(res.data.handoff, true)
      const publishPreview = await window.api.getOpenCodeCommitPreview(finding.id)
      if (publishPreview.ok) setHasUnpublishedChanges(publishPreview.data.files.length > 0)
      setOpenCodeNote(
        res.data.inProgress
          ? res.data.importedMessages > 0
            ? `Synced ${res.data.importedMessages}; OpenCode is still working`
            : 'OpenCode is still working'
          : res.data.importedMessages > 0
            ? `Synced ${res.data.importedMessages} message${res.data.importedMessages === 1 ? '' : 's'}`
            : 'Up to date'
      )
    })
  }

  async function checkOpenCodeFix(): Promise<void> {
    await withBusy('opencode-check', async () => {
      const res = await window.api.checkOpenCodeFix(finding.id, model)
      if (!res.ok) throw new Error(res.error)
      onOpenCodeChanged?.(res.data)
    })
  }

  async function previewOpenCodeCommit(): Promise<void> {
    await withBusy('opencode-commit-preview', async () => {
      setOpenCodeNote(null)
      const res = await window.api.getOpenCodeCommitPreview(finding.id)
      if (!res.ok) throw new Error(res.error)
      setHasUnpublishedChanges(res.data.files.length > 0)
      if (res.data.files.length === 0) {
        setOpenCodeNote('No changes since the last push')
        return
      }
      setCommitPreview(res.data)
      setCommitMessage(res.data.hasUncommittedChanges ? res.data.suggestedMessage : '')
    })
  }

  async function commitOpenCodeToPr(): Promise<void> {
    if (!commitPreview) return
    setBusy('opencode-commit')
    setError(null)
    try {
      const res = await window.api.commitOpenCodeToPr(
        finding.id,
        commitMessage,
        commitPreview.snapshotId
      )
      if (!res.ok) throw new Error(res.error)
      setCommitPreview(null)
      setHasUnpublishedChanges(false)
      setOpenCodeNote(
        `${res.data.createdCommit ? 'Committed and pushed' : 'Pushed'} ${res.data.commit.slice(0, 8)} to ${res.data.targetBranch}`
      )
      if (posted && !threadIsTerminal(finding.comment?.threadStatus ?? null)) {
        const draft = await window.api.getOpenCodeResolutionComment(finding.id)
        if (draft.ok) {
          setResolutionReply(draft.data)
          setResolveCommentOpen(true)
        } else {
          setError(
            `The push succeeded, but the OpenCode comment could not be loaded. ${draft.error}`
          )
        }
      }
      await onChanged()
    } catch (e) {
      setError((e as Error).message)
      const refreshed = await window.api.getOpenCodeCommitPreview(finding.id)
      if (refreshed.ok) {
        setHasUnpublishedChanges(refreshed.data.files.length > 0)
        setCommitPreview(refreshed.data)
        setCommitMessage(
          refreshed.data.hasUncommittedChanges ? refreshed.data.suggestedMessage : ''
        )
      }
    } finally {
      setBusy(null)
    }
  }

  async function openResolveComment(): Promise<void> {
    await withBusy('comment-draft', async () => {
      const res = await window.api.getOpenCodeResolutionComment(finding.id)
      if (!res.ok) throw new Error(res.error)
      setResolutionReply(res.data)
      setResolveCommentOpen(true)
    })
  }

  async function commentAndResolve(): Promise<void> {
    await withBusy('comment-resolve', async () => {
      const res = await window.api.commentAndResolveFinding(finding.id, resolutionReply)
      if (!res.ok) throw new Error(res.error)
      setResolveCommentOpen(false)
      setOpenCodeNote(
        res.data.resolved
          ? 'Comment posted and Azure DevOps thread resolved'
          : 'Comment posted; Azure DevOps thread is still open'
      )
      if (res.data.warning) setError(res.data.warning)
      await onChanged()
    })
  }

  const posted = finding.comment?.status === 'posted' && finding.comment?.adoThreadId !== null
  const dirty = !!finding.comment && commentText !== finding.comment.draftText
  const threadStatusValue =
    THREAD_STATUS_OPTIONS.find(
      (o) => o.value.toLowerCase() === (finding.comment?.threadStatus ?? 'active').toLowerCase()
    )?.value ?? 'active'
  const fixVerdict = openCodeHandoff?.fixAssessment?.verdict
  const fixLabel =
    fixVerdict === 'resolved'
      ? 'Fix ready'
      : fixVerdict === 'unresolved'
        ? 'Fix not ready'
        : fixVerdict === 'unclear'
          ? 'Fix unclear'
          : 'OpenCode linked'
  const prAssessment = openCodeHandoff?.prAssessment
  const prAssessmentIsCurrent =
    !!prAssessment && (!currentHeadCommit || prAssessment.checkedCommit === currentHeadCommit)
  const prLabel = !prAssessment
    ? null
    : !prAssessmentIsCurrent
      ? 'PR check stale'
      : prAssessment.verdict === 'resolved'
        ? 'Resolved on PR'
        : prAssessment.verdict === 'unresolved'
          ? 'Not resolved on PR'
          : 'PR result unclear'

  return (
    <div ref={cardRef} className={`finding status-${finding.status}`}>
      <div className="finding-top" onClick={() => setExpanded((v) => !v)}>
        <span className="finding-id mono">{finding.publicId}</span>
        <span className="finding-title">{finding.title}</span>
        {finding.model && (
          <span className="finding-model" title={`Raised by ${finding.model}`}>
            {finding.model}
          </span>
        )}
        {finding.contributors.length > 0 && (
          <span
            className="finding-model contributor"
            title={`Also flagged by ${finding.contributors.join(', ')}`}
          >
            +{finding.contributors.length}
          </span>
        )}
        {openCodeHandoff && (
          <span className={`opencode-finding-pill ${fixVerdict ?? 'linked'}`}>{fixLabel}</span>
        )}
        {prAssessment && (
          <span
            className={`opencode-finding-pill ${prAssessmentIsCurrent ? prAssessment.verdict : 'stale'}`}
          >
            {prLabel}
          </span>
        )}
        <span className={`status-pill ${finding.status}`}>{finding.status}</span>
        <button className="expander">{expanded ? '▾' : '▸'}</button>
      </div>

      {expanded && (
        <div className="finding-body">
          <p>{finding.description}</p>
          {finding.filePath && (
            <div className="finding-loc mono small">
              {finding.filePath}
              {finding.line ? `:${finding.line}` : ''}
            </div>
          )}

          {openCodeHandoff && (
            <div className="finding-opencode">
              <div className="finding-opencode-head">
                <div>
                  <strong>OpenCode work session</strong>
                  <div className="muted small mono">{openCodeHandoff.branchName}</div>
                </div>
                <span className={`opencode-finding-pill ${fixVerdict ?? 'linked'}`}>
                  {fixLabel}
                </span>
              </div>

              {openCodeHandoff.changedFiles.length > 0 ? (
                <ul className="opencode-files">
                  {openCodeHandoff.changedFiles.map((file) => (
                    <li key={file.path}>
                      <span className="mono">{file.path}</span>
                      <span className="opencode-file-stats">
                        <span className="add">+{file.additions}</span>
                        <span className="del">-{file.deletions}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="muted small">No changed files synced yet.</div>
              )}

              <div className="finding-opencode-actions">
                <button className="btn small-btn" onClick={openCode} disabled={busy !== null}>
                  {busy === 'opencode-open' ? 'Opening…' : 'Reopen in Terminal'}
                </button>
                <button className="btn small-btn" onClick={syncOpenCode} disabled={busy !== null}>
                  {busy === 'opencode-sync' ? 'Syncing…' : 'Sync back'}
                </button>
                <button
                  className="btn subtle small-btn"
                  onClick={checkOpenCodeFix}
                  disabled={busy !== null}
                >
                  {busy === 'opencode-check' ? 'Checking…' : 'Check worktree fix'}
                </button>
                <button
                  className="btn primary small-btn"
                  onClick={() => void previewOpenCodeCommit()}
                  disabled={busy !== null || checkingPublishState || hasUnpublishedChanges !== true}
                  title={
                    hasUnpublishedChanges === false
                      ? 'No worktree changes have been made since the last push'
                      : undefined
                  }
                >
                  {busy === 'opencode-commit-preview'
                    ? 'Inspecting…'
                    : checkingPublishState || hasUnpublishedChanges === null
                      ? 'Checking changes…'
                      : hasUnpublishedChanges
                        ? 'Commit and push to PR'
                        : 'Up to date'}
                </button>
                <button
                  className="btn subtle small-btn"
                  onClick={checkResolved}
                  disabled={busy !== null}
                >
                  {busy === 'resolve' ? 'Checking…' : 'Check PR resolution'}
                </button>
                {posted && !threadIsTerminal(finding.comment?.threadStatus ?? null) && (
                  <button
                    className="btn small-btn"
                    onClick={() => void openResolveComment()}
                    disabled={busy !== null}
                  >
                    {busy === 'comment-draft' ? 'Loading comment…' : 'Comment and resolve'}
                  </button>
                )}
                {openCodeNote && <span className="muted small">{openCodeNote}</span>}
              </div>

              {commitPreview && (
                <>
                  <div
                    className="opencode-publish-scrim"
                    onClick={() => {
                      if (busy === null) {
                        setCommitPreview(null)
                        setError(null)
                      }
                    }}
                  />
                  <div
                    className="opencode-publish-dialog"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby={`opencode-publish-title-${finding.id}`}
                  >
                    <div className="opencode-publish-head">
                      <strong id={`opencode-publish-title-${finding.id}`}>
                        Commit and push {finding.publicId}
                      </strong>
                      <p className="muted small">
                        Destination{' '}
                        <span className="mono">origin/{commitPreview.targetBranch}</span>
                      </p>
                    </div>

                    <div className="opencode-publish-summary small">
                      {commitPreview.hasUncommittedChanges
                        ? `The listed worktree changes will be committed, rebased onto the latest source branch, and pushed.${commitPreview.commitsAhead > 0 ? ` This also includes ${commitPreview.commitsAhead} existing ${commitPreview.commitsAhead === 1 ? 'commit' : 'commits'}.` : ''}`
                        : `${commitPreview.commitsAhead} existing ${commitPreview.commitsAhead === 1 ? 'commit' : 'commits'} will be rebased onto the latest source branch and pushed.`}
                    </div>

                    <div className="opencode-publish-files" aria-label="Files to push">
                      {commitPreview.files.map((path) => (
                        <div key={path} className="mono small">
                          {path}
                        </div>
                      ))}
                    </div>

                    {commitPreview.hasUncommittedChanges && (
                      <label className="opencode-publish-field">
                        <span className="muted small">Commit message</span>
                        <input
                          value={commitMessage}
                          maxLength={200}
                          autoFocus
                          onChange={(event) => setCommitMessage(event.target.value)}
                        />
                      </label>
                    )}

                    {error && <div className="banner err small">{error}</div>}

                    <div className="opencode-publish-actions">
                      <button
                        className="btn subtle small-btn"
                        onClick={() => {
                          setCommitPreview(null)
                          setError(null)
                        }}
                        disabled={busy !== null}
                      >
                        Cancel
                      </button>
                      <button
                        className="btn primary small-btn"
                        onClick={() => void commitOpenCodeToPr()}
                        disabled={
                          busy !== null ||
                          (commitPreview.hasUncommittedChanges && !commitMessage.trim())
                        }
                      >
                        {busy === 'opencode-commit'
                          ? 'Sending…'
                          : commitPreview.hasUncommittedChanges
                            ? 'Commit and push'
                            : 'Push to PR'}
                      </button>
                    </div>
                  </div>
                </>
              )}

              {resolveCommentOpen && (
                <>
                  <div
                    className="opencode-publish-scrim"
                    onClick={() => {
                      if (busy === null) {
                        setResolveCommentOpen(false)
                        setError(null)
                      }
                    }}
                  />
                  <div
                    className="opencode-publish-dialog opencode-resolve-dialog"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby={`opencode-resolve-title-${finding.id}`}
                  >
                    <div className="opencode-publish-head">
                      <strong id={`opencode-resolve-title-${finding.id}`}>
                        Comment and resolve {finding.publicId}
                      </strong>
                      <p className="muted small">
                        This reply will be posted to the existing Azure DevOps thread before it is
                        marked Resolved.
                      </p>
                    </div>

                    <label className="opencode-publish-field">
                      <span className="muted small">Reply</span>
                      <input
                        value={resolutionReply}
                        maxLength={200}
                        autoFocus
                        onChange={(event) => setResolutionReply(event.target.value)}
                      />
                    </label>

                    {error && <div className="banner err small">{error}</div>}

                    <div className="opencode-publish-actions">
                      <button
                        className="btn subtle small-btn"
                        onClick={() => {
                          setResolveCommentOpen(false)
                          setError(null)
                        }}
                        disabled={busy !== null}
                      >
                        Cancel
                      </button>
                      <button
                        className="btn primary small-btn"
                        onClick={() => void commentAndResolve()}
                        disabled={busy !== null || !resolutionReply.trim()}
                      >
                        {busy === 'comment-resolve' ? 'Posting…' : 'Post reply and resolve'}
                      </button>
                    </div>
                  </div>
                </>
              )}

              {openCodeHandoff.fixAssessment && (
                <div className={`resolution-result ${openCodeHandoff.fixAssessment.verdict}`}>
                  <span className="resolution-verdict">
                    {openCodeHandoff.fixAssessment.verdict === 'resolved'
                      ? 'Fix ready in OpenCode'
                      : openCodeHandoff.fixAssessment.verdict === 'unresolved'
                        ? 'Fix not ready in OpenCode'
                        : 'Worktree result unclear'}
                  </span>
                  <p className="resolution-explanation">
                    {openCodeHandoff.fixAssessment.explanation}
                  </p>
                </div>
              )}
              {prAssessment && (
                <div
                  className={`resolution-result ${prAssessmentIsCurrent ? prAssessment.verdict : 'unclear'}`}
                >
                  <span className="resolution-verdict">{prLabel}</span>
                  <p className="resolution-explanation">{prAssessment.explanation}</p>
                  <div className="muted small mono">
                    Checked {prAssessment.checkedCommit.slice(0, 8)}
                  </div>
                </div>
              )}
              <div className="muted small opencode-scope-note">
                This checks only the isolated worktree. PR resolution is checked separately against
                the source branch.
              </div>
            </div>
          )}

          {showCode && code && (
            <pre className="code-block">
              {code.lines.map((ln, i) => {
                const isTarget = ln.newLine !== null && ln.newLine === code.targetLine
                const sign = ln.kind === 'add' ? '+' : ln.kind === 'del' ? '-' : ' '
                const cls = `code-line ${ln.kind}${isTarget ? ' target' : ''}`
                return (
                  <div key={i} className={cls}>
                    <span className="ln">{ln.oldLine ?? ''}</span>
                    <span className="ln">{ln.newLine ?? ''}</span>
                    <span className="sign">{sign}</span>
                    <span className="lc">{ln.text === '' ? ' ' : ln.text}</span>
                  </div>
                )
              })}
            </pre>
          )}
          {showCode && code && !code.isDiff && (
            <div className="muted small">
              This file is unchanged in the PR — showing current content.
            </div>
          )}
          {showCode && code && code.targetLine === null && (
            <div className="muted small">
              No specific line was recorded — showing the top of the file.
            </div>
          )}

          {finding.explanation && (
            <div className="explanation">
              <strong>Explanation</strong>
              <div className="markdown">
                <Markdown>{finding.explanation}</Markdown>
              </div>
            </div>
          )}

          {finding.comment && (
            <div className="comment-draft">
              <strong>
                {posted
                  ? 'Comment (posted to Azure DevOps)'
                  : finding.comment.status === 'posted'
                    ? 'Comment (marked posted locally)'
                    : 'Comment (draft)'}
              </strong>

              {posted ? (
                <>
                  <div className="thread-state">
                    <span
                      className={`thread-pill ${threadStateClass(finding.comment.threadStatus)}`}
                    >
                      {threadStateLabel(finding.comment.threadStatus)}
                    </span>
                    <span className="muted small">
                      {finding.comment.replyCount === 0
                        ? 'No replies yet'
                        : `${finding.comment.replyCount} repl${finding.comment.replyCount === 1 ? 'y' : 'ies'}`}
                    </span>
                    <span className="spacer" />
                    <select
                      className="mini-status-select"
                      title="Set the Azure DevOps comment status"
                      value={threadStatusValue}
                      onChange={(e) => void setThreadStatus(e.target.value)}
                      disabled={busy !== null}
                    >
                      {THREAD_STATUS_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* The full thread: our posted comment first, then any replies. */}
                  <div className="replies thread-conversation">
                    <div className="reply mine">
                      <div className="reply-head small">
                        <span className="reply-author">You</span>
                        {finding.comment.postedAt && (
                          <span className="muted">
                            {' · '}
                            {new Date(finding.comment.postedAt).toLocaleString()}
                          </span>
                        )}
                      </div>
                      <div className="reply-text">{finding.comment.draftText}</div>
                    </div>
                    {finding.comment.replies.map((r, i) => (
                      <div key={i} className="reply">
                        <div className="reply-head small">
                          <span className="reply-author">{r.author}</span>
                          {r.date && (
                            <span className="muted"> · {new Date(r.date).toLocaleString()}</span>
                          )}
                        </div>
                        <div className="reply-text">{r.text}</div>
                      </div>
                    ))}
                  </div>

                  {finding.comment.replyCount > 0 && !openCodeHandoff && (
                    <div className="resolution-check">
                      <button
                        className="btn subtle small-btn"
                        onClick={checkResolved}
                        disabled={busy !== null}
                        title="Check whether the latest PR source branch resolves this finding"
                      >
                        {busy === 'resolve' ? 'Checking…' : 'Check PR resolution'}
                      </button>
                      {resolution && (
                        <div className={`resolution-result ${resolution.verdict}`}>
                          <span className="resolution-verdict">
                            {resolution.verdict === 'resolved'
                              ? '✓ Resolved on PR'
                              : resolution.verdict === 'unresolved'
                                ? '✕ Not resolved on PR'
                                : '? Unclear'}
                          </span>
                          <p className="resolution-explanation">{resolution.explanation}</p>
                        </div>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <textarea
                    className="comment-editor"
                    value={commentText}
                    onChange={(e) => setCommentText(e.target.value)}
                    rows={5}
                    disabled={busy !== null}
                  />

                  <div className="refine-row">
                    <span className="muted small">Fine-tune:</span>
                    {REFINEMENTS.map((r) => (
                      <button
                        key={r.key}
                        className="btn subtle small-btn"
                        onClick={() => refine(r.key, r.instruction)}
                        disabled={busy !== null}
                      >
                        {busy === `refine-${r.key}` ? '…' : r.label}
                      </button>
                    ))}
                    <form className="custom-refine" onSubmit={submitCustomRefinement}>
                      <input
                        className="custom-refine-input"
                        type="text"
                        value={customRefinement}
                        onChange={(e) => setCustomRefinement(e.target.value)}
                        placeholder="Other instruction"
                        aria-label="Custom redraft instruction"
                        maxLength={160}
                        disabled={busy !== null}
                      />
                      <button
                        className="btn subtle small-btn"
                        type="submit"
                        disabled={busy !== null || customRefinement.trim().length === 0}
                      >
                        {busy === 'refine-custom' ? '…' : 'Apply'}
                      </button>
                    </form>
                    <span className="spacer" />
                    <button className="btn" onClick={saveEdit} disabled={busy !== null || !dirty}>
                      {busy === 'save' ? '…' : 'Save edits'}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {error && <div className="banner err">{error}</div>}

          <div className="finding-actions">
            <button className="btn" onClick={explain} disabled={busy !== null}>
              {busy === 'explain' ? '…' : 'Explain this finding'}
            </button>
            {finding.filePath && (
              <button className="btn" onClick={viewCode} disabled={busy !== null}>
                {busy === 'code' ? '…' : showCode ? 'Hide code' : 'View code'}
              </button>
            )}
            {finding.filePath && onOpenInFiles && (
              <button
                className="btn"
                onClick={() => onOpenInFiles(finding.filePath as string, finding.line)}
              >
                Show in Files
              </button>
            )}
            {onChatAbout && (
              <button
                className="btn"
                onClick={() => onChatAbout(finding)}
                title="Ask the assistant about this finding"
              >
                💬 Chat about this finding
              </button>
            )}
            {!openCodeHandoff && (
              <button className="btn" onClick={openCode} disabled={busy !== null}>
                {busy === 'opencode-open' ? 'Opening…' : 'Open in OpenCode'}
              </button>
            )}
            <button className="btn" onClick={draft} disabled={busy !== null || posted}>
              {busy === 'draft' ? '…' : finding.comment ? 'Re-draft' : 'Draft a comment'}
            </button>
            <button
              className="btn primary"
              onClick={post}
              disabled={busy !== null || !finding.comment || posted || dirty}
              title={dirty ? 'Save your edits before posting' : undefined}
            >
              {busy === 'post' ? '…' : posted ? 'Posted' : 'Post to Azure DevOps'}
            </button>
            <span className="spacer" />
            <button
              className={finding.status === 'accepted' ? 'btn subtle active-accept' : 'btn subtle'}
              onClick={() => setStatus('accepted')}
              disabled={busy !== null}
              title="Mark as accepted"
            >
              ✓ Accept
            </button>
            <button
              className={
                finding.status === 'dismissed' ? 'btn subtle active-dismiss' : 'btn subtle'
              }
              onClick={() => setStatus('dismissed')}
              disabled={busy !== null}
              title="Dismiss this finding"
            >
              ✕ Dismiss
            </button>
            <button
              className="btn subtle"
              onClick={() => setStatus('open')}
              disabled={busy !== null || finding.status === 'open'}
              title="Reset to open"
            >
              ↺ Reset
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
