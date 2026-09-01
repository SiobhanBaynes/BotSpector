import { useEffect, useState } from 'react'
import type { AdoCommentThread, CodeSnippet } from '../../../shared/types'
import { Markdown } from '../components/Markdown'

interface Props {
  prId: number
  model: string
  /** Open (and scroll to) a file/line in the Files tab. */
  onOpenInFiles?: (path: string, line: number | null) => void
  /** Called after a finding is created from an ADO comment, so the review reloads. */
  onFindingCreated?: () => void
}

// Map Azure DevOps thread status values to a friendly label.
function statusLabel(status: string | null): string {
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

function statusClass(status: string | null): string {
  switch ((status ?? '').toLowerCase()) {
    case 'fixed':
    case 'closed':
    case 'bydesign':
      return 'resolved'
    case 'wontfix':
      return 'wontfix'
    case 'active':
    case 'pending':
      return 'open'
    default:
      return 'unknown'
  }
}

/** Shows the Azure DevOps comment threads on a PR (including ones raised by
 *  other reviewers), each with Explain / View code / Show in Files / Reply. */
export function AdoCommentsTab({
  prId,
  model,
  onOpenInFiles,
  onFindingCreated
}: Props): JSX.Element {
  const [threads, setThreads] = useState<AdoCommentThread[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [explanations, setExplanations] = useState<Record<number, string>>({})
  const [busy, setBusy] = useState<Record<number, string | null>>({})
  const [code, setCode] = useState<Record<number, CodeSnippet | null>>({})
  const [showCode, setShowCode] = useState<Record<number, boolean>>({})
  const [replyText, setReplyText] = useState<Record<number, string>>({})
  const [createdFindingId, setCreatedFindingId] = useState<Record<number, string>>({})

  useEffect(() => {
    let cancelled = false
    async function load(): Promise<void> {
      setLoading(true)
      setError(null)
      const res = await window.api.getAdoComments(prId)
      if (cancelled) return
      setLoading(false)
      if (res.ok) setThreads(res.data)
      else setError(res.error)
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [prId])

  function setThreadBusy(id: number, key: string | null): void {
    setBusy((b) => ({ ...b, [id]: key }))
  }

  async function explain(thread: AdoCommentThread): Promise<void> {
    setThreadBusy(thread.id, 'explain')
    setError(null)
    const commentText = thread.comments.map((c) => `${c.author}: ${c.content}`).join('\n\n')
    const res = await window.api.explainAdoComment(
      prId,
      thread.filePath,
      thread.line,
      commentText,
      model
    )
    setThreadBusy(thread.id, null)
    if (res.ok) setExplanations((x) => ({ ...x, [thread.id]: res.data }))
    else setError(res.error)
  }

  async function viewCode(thread: AdoCommentThread): Promise<void> {
    if (!thread.filePath) return
    if (showCode[thread.id]) {
      setShowCode((s) => ({ ...s, [thread.id]: false }))
      return
    }
    if (code[thread.id]) {
      setShowCode((s) => ({ ...s, [thread.id]: true }))
      return
    }
    setThreadBusy(thread.id, 'code')
    setError(null)
    const res = await window.api.getCodeSnippet(prId, thread.filePath, thread.line)
    setThreadBusy(thread.id, null)
    if (res.ok) {
      setCode((c) => ({ ...c, [thread.id]: res.data }))
      setShowCode((s) => ({ ...s, [thread.id]: true }))
    } else setError(res.error)
  }

  async function reply(thread: AdoCommentThread): Promise<void> {
    const text = (replyText[thread.id] ?? '').trim()
    if (!text) return
    setThreadBusy(thread.id, 'reply')
    setError(null)
    const res = await window.api.replyToAdoComment(prId, thread.id, text)
    setThreadBusy(thread.id, null)
    if (res.ok) {
      setThreads(res.data)
      setReplyText((r) => ({ ...r, [thread.id]: '' }))
    } else setError(res.error)
  }

  async function createFinding(thread: AdoCommentThread): Promise<void> {
    setThreadBusy(thread.id, 'finding')
    setError(null)
    const res = await window.api.createFindingFromAdoComment(prId, thread.id, model)
    setThreadBusy(thread.id, null)
    if (res.ok) {
      setCreatedFindingId((m) => ({ ...m, [thread.id]: res.data.publicId }))
      onFindingCreated?.()
    } else setError(res.error)
  }

  return (
    <div className="ado-comments-tab">
      {loading && (
        <div className="banner info reviewing-banner">
          <span className="spinner" /> Loading Azure DevOps comments…
        </div>
      )}
      {error && <div className="banner err">{error}</div>}
      {!loading && threads.length === 0 && !error && (
        <div className="empty">No comment threads on this pull request yet.</div>
      )}

      {threads.map((t) => {
        const tBusy = busy[t.id] ?? null
        const snippet = code[t.id]
        return (
          <div key={t.id} className="ado-thread">
            <div className="ado-thread-head">
              <span className={`thread-pill ${statusClass(t.status)}`}>
                {statusLabel(t.status)}
              </span>
              {t.filePath ? (
                <span className="ado-thread-loc mono small">
                  {t.filePath}
                  {t.line ? `:${t.line}` : ''}
                </span>
              ) : (
                <span className="muted small">General comment</span>
              )}
            </div>

            <div className="ado-thread-comments">
              {t.comments.map((c, i) => (
                <div key={i} className="ado-comment">
                  <div className="ado-comment-meta small muted">
                    <span className="ado-comment-author">{c.author}</span>
                    {c.date && <span> · {new Date(c.date).toLocaleString()}</span>}
                  </div>
                  <div className="ado-comment-body markdown">
                    <Markdown>{c.content}</Markdown>
                  </div>
                </div>
              ))}
            </div>

            {showCode[t.id] && snippet && (
              <>
                <pre className="code-block">
                  {snippet.lines.map((ln, i) => {
                    const isTarget = ln.newLine !== null && ln.newLine === snippet.targetLine
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
                {!snippet.isDiff && (
                  <div className="muted small">
                    This file is unchanged in the PR — showing current content.
                  </div>
                )}
              </>
            )}

            {explanations[t.id] && (
              <div className="explanation">
                <strong>In plain language</strong>
                <div className="markdown">
                  <Markdown>{explanations[t.id]}</Markdown>
                </div>
              </div>
            )}

            <div className="ado-thread-reply">
              <textarea
                className="comment-editor"
                value={replyText[t.id] ?? ''}
                onChange={(e) => setReplyText((r) => ({ ...r, [t.id]: e.target.value }))}
                placeholder="Write a reply…"
                rows={2}
                disabled={tBusy !== null}
              />
              <div className="ado-thread-actions">
                <button className="btn" onClick={() => void explain(t)} disabled={tBusy !== null}>
                  {tBusy === 'explain' ? '…' : 'Explain this comment'}
                </button>
                {t.filePath && (
                  <button
                    className="btn"
                    onClick={() => void viewCode(t)}
                    disabled={tBusy !== null}
                  >
                    {tBusy === 'code' ? '…' : showCode[t.id] ? 'Hide code' : 'View code'}
                  </button>
                )}
                {t.filePath && onOpenInFiles && (
                  <button
                    className="btn"
                    onClick={() => onOpenInFiles(t.filePath as string, t.line)}
                  >
                    Show in Files
                  </button>
                )}
                {createdFindingId[t.id] ? (
                  <span className="chat-finding-created small">
                    ✓ Added finding {createdFindingId[t.id]}
                  </span>
                ) : (
                  <button
                    className="btn"
                    onClick={() => void createFinding(t)}
                    disabled={tBusy !== null}
                    title="Turn this reviewer's comment into a review finding you can track and address"
                  >
                    {tBusy === 'finding' ? 'Creating…' : '+ Create finding'}
                  </button>
                )}
                <span className="spacer" />
                <button
                  className="btn primary"
                  onClick={() => void reply(t)}
                  disabled={tBusy !== null || !(replyText[t.id] ?? '').trim()}
                >
                  {tBusy === 'reply' ? 'Posting…' : 'Reply'}
                </button>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
