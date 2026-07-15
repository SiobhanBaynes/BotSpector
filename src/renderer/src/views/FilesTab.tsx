import { useEffect, useRef, useState } from 'react'
import type { ChangedFile, FileDiff } from '../../../shared/types'
import { DiffView } from '../components/DiffView'

export interface FileRequest {
  path: string
  line: number | null
  nonce: number
}

interface Props {
  prId: number
  /** External request to open (and scroll to) a specific file. */
  request?: FileRequest | null
}

export function FilesTab({ prId, request }: Props): JSX.Element {
  const [files, setFiles] = useState<ChangedFile[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [diffs, setDiffs] = useState<Record<string, FileDiff>>({})
  const [prefetched, setPrefetched] = useState(0)
  const [highlight, setHighlight] = useState<{ path: string; line: number | null } | null>(null)
  const fileRefs = useRef<Record<string, HTMLDivElement | null>>({})

  // Load the changed-file list as soon as this component mounts.
  useEffect(() => {
    let cancelled = false
    async function loadFiles(): Promise<void> {
      setLoading(true)
      setError(null)
      const res = await window.api.getChangedFiles(prId)
      if (cancelled) return
      setLoading(false)
      if (res.ok) setFiles(res.data)
      else setError(res.error)
    }
    void loadFiles()
    return () => {
      cancelled = true
    }
  }, [prId])

  // Background-prefetch every file's diff so expanding is instant.
  useEffect(() => {
    if (files.length === 0) return
    let cancelled = false
    async function prefetch(): Promise<void> {
      let count = 0
      for (const f of files) {
        if (cancelled) return
        const res = await window.api.getFileDiff(prId, f.path)
        if (cancelled) return
        if (res.ok) setDiffs((d) => ({ ...d, [f.path]: res.data }))
        count++
        setPrefetched(count)
      }
    }
    void prefetch()
    return () => {
      cancelled = true
    }
  }, [files, prId])

  async function ensureDiff(path: string): Promise<void> {
    if (diffs[path]) return
    const res = await window.api.getFileDiff(prId, path)
    if (res.ok) setDiffs((d) => ({ ...d, [path]: res.data }))
    else setError(res.error)
  }

  // Respond to an external request to open a specific file (from a finding).
  useEffect(() => {
    if (!request) return
    const { path, line } = request
    setOpen((o) => ({ ...o, [path]: true }))
    setHighlight({ path, line })
    void ensureDiff(path)
    const t = setTimeout(() => {
      fileRefs.current[path]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 120)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.nonce])

  async function toggle(path: string): Promise<void> {
    const isOpen = !!open[path]
    setOpen((o) => ({ ...o, [path]: !isOpen }))
    if (!isOpen) await ensureDiff(path)
  }

  const prefetchDone = files.length > 0 && prefetched >= files.length

  return (
    <div className="files-tab">
      {loading && (
        <div className="banner info reviewing-banner">
          <span className="spinner" /> Loading changed files…
        </div>
      )}
      {error && <div className="banner err">{error}</div>}
      {!loading && files.length === 0 && !error && (
        <div className="empty">No changed files found for this pull request.</div>
      )}

      {files.length > 0 && !prefetchDone && (
        <div className="muted small prefetch-note">
          <span className="spinner" /> Loading diffs in background ({prefetched}/{files.length})…
        </div>
      )}

      {files.map((f) => {
        const diff = diffs[f.path]
        const hl = highlight?.path === f.path ? highlight.line : null
        return (
          <div
            key={f.path}
            className="file-item"
            ref={(el) => {
              fileRefs.current[f.path] = el
            }}
          >
            <div className="file-head" onClick={() => toggle(f.path)}>
              <span className="expander">{open[f.path] ? '▾' : '▸'}</span>
              <span className={`change-badge ${f.changeType.toLowerCase().replace(/[^a-z]/g, '')}`}>
                {changeLabel(f.changeType)}
              </span>
              <span className="file-path mono">{f.path}</span>
              {diff && (
                <span className="file-stat">
                  <span className="stat-add">+{diff.added}</span>{' '}
                  <span className="stat-del">−{diff.removed}</span>
                </span>
              )}
            </div>
            {open[f.path] && (
              <div className="file-diff">
                {!diff && (
                  <div className="muted small">
                    <span className="spinner" /> Loading diff…
                  </div>
                )}
                {diff && diff.lines.length === 0 && (
                  <div className="muted small">No line changes (metadata or rename only).</div>
                )}
                {diff && diff.lines.length > 0 && (
                  <DiffView lines={diff.lines} highlightNewLine={hl} />
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function changeLabel(changeType: string): string {
  const t = changeType.toLowerCase()
  if (t.includes('add')) return 'Added'
  if (t.includes('delete')) return 'Deleted'
  if (t.includes('rename')) return 'Renamed'
  if (t.includes('edit')) return 'Edited'
  return changeType
}
