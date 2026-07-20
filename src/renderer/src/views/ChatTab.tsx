import { useEffect, useRef, useState } from 'react'
import type { ChatMessage } from '../../../shared/types'

interface Props {
  prId: number
  model: string
}

export function ChatTab({ prId, model }: Props): JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Reset the conversation when switching to a different PR.
  useEffect(() => {
    setMessages([])
    setInput('')
    setError(null)
  }, [prId])

  // Keep the transcript scrolled to the latest message.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, busy])

  async function send(): Promise<void> {
    const text = input.trim()
    if (!text || busy) return
    const history: ChatMessage[] = [...messages, { role: 'user', content: text }]
    setMessages(history)
    setInput('')
    setBusy(true)
    setError(null)
    try {
      const res = await window.api.chatAboutPr(prId, history, model)
      if (!res.ok) throw new Error(res.error)
      setMessages([...history, { role: 'assistant', content: res.data }])
    } catch (e) {
      setError((e as Error).message)
      // Roll back the optimistic user message's turn indicator; keep the message.
    } finally {
      setBusy(false)
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
      <div className="chat-transcript" ref={scrollRef}>
        {messages.length === 0 && !busy && (
          <div className="chat-empty muted">
            Ask anything about this pull request — the review findings, a specific file, why a
            change matters, or how to address a comment. The assistant can read the PR&apos;s
            changed files on demand.
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`chat-msg ${m.role}`}>
            <div className="chat-role small muted">{m.role === 'user' ? 'You' : 'Assistant'}</div>
            <div className="chat-bubble">{m.content}</div>
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
      </div>

      {error && <div className="banner err">{error}</div>}

      <div className="chat-input-row">
        <textarea
          className="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask about this PR…  (Enter to send, Shift+Enter for a new line)"
          rows={2}
          disabled={busy}
        />
        <button className="btn primary" onClick={() => void send()} disabled={busy || !input.trim()}>
          {busy ? '…' : 'Send'}
        </button>
      </div>
    </div>
  )
}
