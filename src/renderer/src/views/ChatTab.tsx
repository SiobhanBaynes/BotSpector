import { useEffect, useRef, useState } from 'react'
import type {
  ChatMessage,
  OpenCodeHandoff,
  OpenCodeStatus,
  PinnedChange
} from '../../../shared/types'
import { Markdown } from '../components/Markdown'

interface Props {
  prId: number
  model: string
  localCheckoutConfigured: boolean
  /** A file change pinned from the Files tab to attach to the next message. */
  pinnedChange?: PinnedChange | null
  /** Clear the pinned change (after sending or when the user removes it). */
  onClearPinnedChange?: () => void
  /** Called after a finding is created from a chat message, so the review reloads. */
  onFindingCreated?: () => void
}

// Per-message state for the "Create finding" action, keyed by message index.
interface FindingState {
  busy?: boolean
  createdId?: string
  error?: string
}

export function ChatTab({
  prId,
  model,
  localCheckoutConfigured,
  pinnedChange,
  onClearPinnedChange,
  onFindingCreated
}: Props): JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [findingState, setFindingState] = useState<Record<number, FindingState>>({})
  const [openCodeStatus, setOpenCodeStatus] = useState<OpenCodeStatus | null>(null)
  const [openCodeHandoff, setOpenCodeHandoff] = useState<OpenCodeHandoff | null>(null)
  const [openCodeBusy, setOpenCodeBusy] = useState(false)
  const [openCodeNote, setOpenCodeNote] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Focus the composer when a change is pinned from the Files tab.
  useEffect(() => {
    if (pinnedChange) inputRef.current?.focus()
  }, [pinnedChange])

  // Load the persisted conversation for this PR (and reset when it changes).
  useEffect(() => {
    let cancelled = false
    setMessages([])
    setInput('')
    setError(null)
    setFindingState({})
    setOpenCodeHandoff(null)
    setOpenCodeNote(null)
    void Promise.all([
      window.api.getChatHistory(prId),
      window.api.getOpenCodeStatus(),
      window.api.getOpenCodeHandoff(prId)
    ]).then(([historyRes, statusRes, handoffRes]) => {
      if (cancelled) return
      if (historyRes.ok) setMessages(historyRes.data)
      if (statusRes.ok) setOpenCodeStatus(statusRes.data)
      if (handoffRes.ok) setOpenCodeHandoff(handoffRes.data)
    })
    return () => {
      cancelled = true
    }
  }, [prId])

  // Keep the latest message in view (the page is the scroll container).
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [messages, busy])

  async function send(): Promise<void> {
    const text = input.trim()
    if ((!text && !pinnedChange) || busy) return
    // When something is pinned, prefix the message with a reference so the
    // assistant knows which change or finding we're asking about.
    const content = pinnedChange ? `${pinPrefix(pinnedChange)}\n\n${text}`.trim() : text
    // Optimistically show the user's message; the server persists on success.
    setMessages((m) => [...m, { role: 'user', content }])
    setInput('')
    onClearPinnedChange?.()
    setBusy(true)
    setError(null)
    try {
      const res = await window.api.chatAboutPr(prId, content, model)
      if (!res.ok) throw new Error(res.error)
      setMessages((m) => [...m, { role: 'assistant', content: res.data }])
    } catch (e) {
      setError((e as Error).message)
      // The turn wasn't persisted, so roll back the optimistic message.
      setMessages((m) => m.slice(0, -1))
      setInput(text)
    } finally {
      setBusy(false)
    }
  }

  async function clear(): Promise<void> {
    if (busy) return
    const res = await window.api.clearChat(prId)
    if (res.ok) {
      setMessages([])
      setFindingState({})
    } else setError(res.error)
  }

  async function startOpenCode(): Promise<void> {
    if (openCodeBusy || busy) return
    setOpenCodeBusy(true)
    setOpenCodeNote(null)
    setError(null)
    const res = await window.api.startOpenCodeHandoff(prId)
    setOpenCodeBusy(false)
    if (res.ok) {
      setOpenCodeHandoff(res.data)
      setOpenCodeNote('Opened in Terminal')
    } else setError(res.error)
  }

  async function reopenOpenCode(): Promise<void> {
    if (openCodeBusy || busy) return
    setOpenCodeBusy(true)
    setOpenCodeNote(null)
    setError(null)
    const res = await window.api.reopenOpenCodeHandoff(prId)
    setOpenCodeBusy(false)
    if (res.ok) {
      setOpenCodeHandoff(res.data)
      setOpenCodeNote('Reopened in Terminal')
    } else setError(res.error)
  }

  async function syncOpenCode(): Promise<void> {
    if (openCodeBusy || busy) return
    setOpenCodeBusy(true)
    setOpenCodeNote(null)
    setError(null)
    const res = await window.api.syncOpenCodeHandoff(prId)
    if (res.ok) {
      setOpenCodeHandoff(res.data.handoff)
      const history = await window.api.getChatHistory(prId)
      if (history.ok) setMessages(history.data)
      setOpenCodeNote(
        res.data.inProgress
          ? res.data.importedMessages > 0
            ? `Synced ${res.data.importedMessages} · still working`
            : 'OpenCode is still working'
          : res.data.importedMessages > 0
            ? `Synced ${res.data.importedMessages} message${res.data.importedMessages === 1 ? '' : 's'}`
            : 'Up to date'
      )
    } else setError(res.error)
    setOpenCodeBusy(false)
  }

  async function createFinding(index: number, content: string): Promise<void> {
    if (findingState[index]?.busy) return
    setFindingState((s) => ({ ...s, [index]: { busy: true } }))
    const res = await window.api.createFindingFromChat(prId, content, model)
    if (res.ok) {
      setFindingState((s) => ({ ...s, [index]: { createdId: res.data.publicId } }))
      onFindingCreated?.()
    } else {
      setFindingState((s) => ({ ...s, [index]: { error: res.error } }))
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  return (
    <div className="chat-tab">
      <div className="chat-toolbar">
        <span className="muted small chat-toolbar-copy">
          Chat is saved with this PR. The assistant can read the PR&apos;s changed files on demand.
        </span>
        <span className="spacer" />
        {openCodeHandoff ? (
          <div className="opencode-handoff" title={openCodeHandoff.worktreePath}>
            <span className="dot on" />
            <span className="small">
              OpenCode linked
              {openCodeHandoff.changedFiles.length > 0
                ? ` · ${openCodeHandoff.changedFiles.length} changed file${openCodeHandoff.changedFiles.length === 1 ? '' : 's'}`
                : ''}
            </span>
            {openCodeNote && <span className="muted small opencode-note">{openCodeNote}</span>}
            <button
              className="btn subtle small-btn"
              onClick={() => void reopenOpenCode()}
              disabled={openCodeBusy || busy}
            >
              Reopen
            </button>
            <button
              className="btn small-btn"
              onClick={() => void syncOpenCode()}
              disabled={openCodeBusy || busy}
            >
              {openCodeBusy ? 'Working…' : 'Sync back'}
            </button>
          </div>
        ) : (
          <button
            className="btn subtle small-btn"
            onClick={() => void startOpenCode()}
            disabled={
              openCodeBusy || busy || !openCodeStatus?.available || !localCheckoutConfigured
            }
            title={
              !openCodeStatus?.available
                ? 'Configure OpenCode in Settings first'
                : !localCheckoutConfigured
                  ? 'Choose a local checkout for this repository in Settings first'
                  : 'Continue this conversation in an isolated OpenCode worktree'
            }
          >
            {openCodeBusy ? 'Opening…' : 'Continue in OpenCode'}
          </button>
        )}
        <button
          className="btn subtle small-btn"
          onClick={() => void clear()}
          disabled={busy || openCodeBusy || messages.length === 0}
        >
          Clear chat
        </button>
      </div>

      <div className="chat-transcript">
        {messages.length === 0 && !busy && (
          <div className="chat-empty muted">
            Ask anything about this pull request — the review findings, a specific file, why a
            change matters, or how to address a comment.
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`chat-msg ${m.role} ${m.source ?? 'botspector'}`}>
            <div className="chat-role small muted">
              {m.source === 'opencode'
                ? m.role === 'user'
                  ? 'You · OpenCode'
                  : 'OpenCode'
                : m.role === 'user'
                  ? 'You'
                  : 'Assistant'}
            </div>
            <div className="chat-bubble">
              {m.role === 'assistant' ? (
                <div className="markdown">
                  <Markdown>{m.content}</Markdown>
                </div>
              ) : (
                m.content
              )}
            </div>
            {m.role === 'assistant' && (
              <div className="chat-msg-actions">
                {findingState[i]?.createdId ? (
                  <span className="chat-finding-created small">
                    ✓ Added finding {findingState[i]?.createdId}
                  </span>
                ) : (
                  <button
                    className="btn subtle small-btn"
                    onClick={() => void createFinding(i, m.content)}
                    disabled={!!findingState[i]?.busy}
                    title="Turn this reply into a review finding"
                  >
                    {findingState[i]?.busy ? 'Creating…' : '+ Create finding'}
                  </button>
                )}
                {findingState[i]?.error && (
                  <span className="chat-finding-error small">{findingState[i]?.error}</span>
                )}
              </div>
            )}
          </div>
        ))}
        {busy && (
          <div className="chat-msg assistant">
            <div className="chat-role small muted">Assistant</div>
            <div className="chat-bubble">
              <span className="spinner" /> Thinking…
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {error && <div className="banner err">{error}</div>}

      {pinnedChange && (
        <div className="chat-pinned">
          {pinnedChange.kind === 'change' ? (
            <>
              <span className="chat-pinned-label">📌 Change:</span>
              <span className="chat-pinned-path mono">{pinnedChange.path}</span>
            </>
          ) : (
            <>
              <span className="chat-pinned-label">📌 Finding:</span>
              <span className="chat-pinned-path">
                <span className="mono">{pinnedChange.publicId}</span> — {pinnedChange.title}
                {pinnedChange.filePath && (
                  <span className="muted small">
                    {' · '}
                    <span className="mono">
                      {pinnedChange.filePath}
                      {pinnedChange.line ? `:${pinnedChange.line}` : ''}
                    </span>
                  </span>
                )}
              </span>
            </>
          )}
          <button
            className="chat-pinned-remove"
            title="Remove pinned context"
            onClick={() => onClearPinnedChange?.()}
          >
            ×
          </button>
        </div>
      )}

      <div className="chat-input-row">
        <textarea
          ref={inputRef}
          className="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask about this PR…  (Enter to send, Shift+Enter for a new line)"
          rows={2}
          disabled={busy}
        />
        <button
          className="btn primary"
          onClick={() => void send()}
          disabled={busy || (!input.trim() && !pinnedChange)}
        >
          {busy ? '…' : 'Send'}
        </button>
      </div>
    </div>
  )
}

// Prefix a chat message with a reference to the pinned context, so the
// assistant knows which change or finding the user is asking about.
function pinPrefix(pin: PinnedChange): string {
  if (pin.kind === 'change') {
    return `Regarding the change in \`${pin.path}\`:`
  }
  const loc =
    pin.filePath && pin.line
      ? ` (\`${pin.filePath}:${pin.line}\`)`
      : pin.filePath
        ? ` (\`${pin.filePath}\`)`
        : ''
  return `Regarding finding ${pin.publicId} — ${pin.title}${loc}:`
}
