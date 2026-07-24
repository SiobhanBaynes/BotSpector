import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AdoCommentThread } from '../../../shared/types'

interface Props {
  prId: number
  model: string
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
 *  other reviewers), each with an "Explain" action. */
export function AdoCommentsTab({ prId, model }: Props): JSX.Element {
  const [threads, setThreads] = useState<AdoCommentThread[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [explanations, setExplanations] = useState<Record<number, string>>({})
  const [explaining, setExplaining] = useState<Record<number, boolean>>({})

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

  async function explain(thread: AdoCommentThread): Promise<void> {
    setExplaining((e) => ({ ...e, [thread.id]: true }))
    setError(null)
    const commentText = thread.comments
      .map((c) => `${c.author}: ${c.content}`)
      .join('\n\n')
    const res = await window.api.explainAdoComment(
      prId,
      thread.filePath,
      thread.line,
      commentText,
      model
    )
    setExplaining((e) => ({ ...e, [thread.id]: false }))
    if (res.ok) setExplanations((x) => ({ ...x, [thread.id]: res.data }))
    else setError(res.error)
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

      {threads.map((t) => (
        <div key={t.id} className="ado-thread">
          <div className="ado-thread-head">
            <span className={`thread-pill ${statusClass(t.status)}`}>{statusLabel(t.status)}</span>
            {t.filePath ? (
              <span className="ado-thread-loc mono small">
                {t.filePath}
                {t.line ? `:${t.line}` : ''}
              </span>
            ) : (
              <span className="muted small">General comment</span>
            )}
            <span className="spacer" />
            <button
              className="btn small-btn"
              onClick={() => void explain(t)}
              disabled={!!explaining[t.id]}
            >
              {explaining[t.id] ? 'Explaining…' : 'Explain'}
            </button>
          </div>

          <div className="ado-thread-comments">
            {t.comments.map((c, i) => (
              <div key={i} className="ado-comment">
                <div className="ado-comment-meta small muted">
                  <span className="ado-comment-author">{c.author}</span>
                  {c.date && <span> · {new Date(c.date).toLocaleString()}</span>}
                </div>
                <div className="ado-comment-body markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{c.content}</ReactMarkdown>
                </div>
              </div>
            ))}
          </div>

          {explanations[t.id] && (
            <div className="explanation">
              <strong>In plain language</strong>
              <div className="markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{explanations[t.id]}</ReactMarkdown>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
