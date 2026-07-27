import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * Renders an image embedded in markdown. Azure DevOps attachment URLs require
 * the PAT and are blocked by the renderer CSP, so we fetch them through the main
 * process and display the returned base64 data URL. Inline data URLs are shown
 * as-is.
 */
function MarkdownImage({ src, alt }: { src?: string; alt?: string }): JSX.Element {
  const [resolved, setResolved] = useState<string | null>(
    src && src.startsWith('data:') ? src : null
  )
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!src || src.startsWith('data:')) return
    let cancelled = false
    setResolved(null)
    setFailed(false)
    window.api
      .fetchImage(src)
      .then((res) => {
        if (cancelled) return
        if (res.ok && res.data) setResolved(res.data)
        else setFailed(true)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [src])

  if (failed) return <span className="muted">🖼️ {alt || 'image'} (couldn’t load)</span>
  if (!resolved) return <span className="muted">🖼️ loading {alt || 'image'}…</span>
  return <img src={resolved} alt={alt ?? ''} loading="lazy" />
}

/**
 * Shared markdown renderer used across the app. Enables GitHub-flavoured
 * markdown and proxies embedded Azure DevOps images through the main process.
 */
export function Markdown({ children }: { children: string }): JSX.Element {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: MarkdownImage }}>
      {children}
    </ReactMarkdown>
  )
}
