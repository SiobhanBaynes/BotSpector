import { useCallback, useEffect, useState } from 'react'
import type { PullRequest } from '../../../shared/types'

interface Props {
  onOpen: (prId: number) => void
  myIdentity: string
}

// How often to silently refresh the PR list (and head commits) in the background.
const AUTO_REFRESH_MS = 3 * 60 * 1000

function isMine(pr: PullRequest, myIdentity: string): boolean {
  const id = myIdentity.trim().toLowerCase()
  if (!id) return false
  const author = pr.author.toLowerCase()
  return author === id || author.includes(id) || id.includes(author)
}

export function PrList({ onOpen, myIdentity }: Props): JSX.Element {
  const [prs, setPrs] = useState<PullRequest[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null)
  const [mineOnly, setMineOnly] = useState(false)

  const refresh = useCallback(async (silent = false): Promise<void> => {
    if (!silent) setLoading(true)
    const res = await window.api.listPullRequests()
    if (!silent) setLoading(false)
    if (res.ok) {
      setPrs(res.data)
      setError(null)
      setLastRefreshed(new Date())
    } else if (!silent) {
      setError(res.error)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Background auto-refresh so stale reviews get flagged without a manual click.
  useEffect(() => {
    const id = setInterval(() => {
      void refresh(true)
    }, AUTO_REFRESH_MS)
    return () => clearInterval(id)
  }, [refresh])

  return (
    <div className="prlist">
      <div className="prlist-header">
        <h1>Pull requests</h1>
        <div className="prlist-actions">
          {myIdentity.trim() && (
            <label className="mine-toggle">
              <input
                type="checkbox"
                checked={mineOnly}
                onChange={(e) => setMineOnly(e.target.checked)}
              />
              Mine only
            </label>
          )}
          {lastRefreshed && (
            <span className="muted small">
              Updated {lastRefreshed.toLocaleTimeString()}
            </span>
          )}
          <button className="btn" onClick={() => refresh()} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && <div className="banner err">{error}</div>}

      {!loading && prs.length === 0 && !error && (
        <div className="empty">
          <p>Nothing to spy on here 👀 — try Refresh, or double-check your Azure DevOps settings.</p>
        </div>
      )}

      <table className="table">
        <thead>
          <tr>
            <th>#</th>
            <th>Title</th>
            <th>Author</th>
            <th>Branch</th>
            <th>Review</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {prs
            .filter((pr) => !mineOnly || isMine(pr, myIdentity))
            .map((pr) => (
              <tr key={pr.id}>
                <td className="mono">{pr.adoPrId}</td>
                <td>
                  {pr.title}
                  {isMine(pr, myIdentity) && <span className="mine-badge">Mine</span>}
                </td>
                <td>{pr.author}</td>
                <td className="mono small">
                  {pr.sourceBranch} → {pr.targetBranch}
                </td>
                <td>
                  <ReviewBadge pr={pr} />
                  {pr.commentReplies > 0 && (
                    <span className="reply-badge" title="New replies on your posted comments">
                      💬 {pr.commentReplies}
                    </span>
                  )}
                </td>
                <td>
                  <button className="btn primary" onClick={() => onOpen(pr.id)}>
                    Open
                  </button>
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  )
}

function ReviewBadge({ pr }: { pr: PullRequest }): JSX.Element {
  const stale =
    pr.reviewStatus === 'reviewed' &&
    !!pr.reviewedCommit &&
    !!pr.headCommit &&
    pr.reviewedCommit !== pr.headCommit

  if (stale) {
    return <span className="review-badge stale">Changes since review</span>
  }

  const map: Record<PullRequest['reviewStatus'], string> = {
    not_reviewed: 'Not reviewed',
    reviewing: 'Reviewing…',
    reviewed: 'Reviewed',
    error: 'Error'
  }
  return <span className={`review-badge ${pr.reviewStatus}`}>{map[pr.reviewStatus]}</span>
}
