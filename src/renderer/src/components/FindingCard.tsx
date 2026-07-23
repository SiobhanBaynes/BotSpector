import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { CodeSnippet, Finding, FindingStatus, ResolutionAssessment } from '../../../shared/types'

interface Props {
  finding: Finding
  model: string
  onChanged: () => Promise<void> | void
  onOpenInFiles?: (path: string, line: number | null) => void
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

// Azure DevOps comment-thread statuses we can set from the app.
const THREAD_STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'active', label: 'Active' },
  { value: 'pending', label: 'Pending' },
  { value: 'fixed', label: 'Resolved' },
  { value: 'wontFix', label: "Won't fix" },
  { value: 'closed', label: 'Closed' },
  { value: 'byDesign', label: 'By design' }
]

export function FindingCard({ finding, model, onChanged, onOpenInFiles }: Props): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [commentText, setCommentText] = useState(finding.comment?.draftText ?? '')
  const [code, setCode] = useState<CodeSnippet | null>(null)
  const [showCode, setShowCode] = useState(false)
  const [resolution, setResolution] = useState<ResolutionAssessment | null>(null)

  // Keep the editable text in sync when the underlying draft changes.
  useEffect(() => {
    setCommentText(finding.comment?.draftText ?? '')
  }, [finding.comment?.draftText])

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
    })
  }

  const posted = finding.comment?.status === 'posted' && finding.comment?.adoThreadId !== null
  const dirty = !!finding.comment && commentText !== finding.comment.draftText
  const threadStatusValue =
    THREAD_STATUS_OPTIONS.find(
      (o) => o.value.toLowerCase() === (finding.comment?.threadStatus ?? 'active').toLowerCase()
    )?.value ?? 'active'

  return (
    <div className={`finding status-${finding.status}`}>
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
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{finding.explanation}</ReactMarkdown>
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
                    <span className={`thread-pill ${threadStateClass(finding.comment.threadStatus)}`}>
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

                  {finding.comment.replyCount > 0 && (
                    <div className="resolution-check">
                      <button
                        className="btn subtle small-btn"
                        onClick={checkResolved}
                        disabled={busy !== null}
                        title="Ask the AI whether the reply and latest commit resolve this finding"
                      >
                        {busy === 'resolve' ? 'Checking…' : 'Check if resolved'}
                      </button>
                      {resolution && (
                        <div className={`resolution-result ${resolution.verdict}`}>
                          <span className="resolution-verdict">
                            {resolution.verdict === 'resolved'
                              ? '✓ Looks resolved'
                              : resolution.verdict === 'unresolved'
                                ? '✕ Not resolved'
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
              className={finding.status === 'dismissed' ? 'btn subtle active-dismiss' : 'btn subtle'}
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

