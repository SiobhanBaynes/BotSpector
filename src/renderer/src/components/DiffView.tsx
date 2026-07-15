import type { DiffLine } from '../../../shared/types'

interface Props {
  lines: DiffLine[]
  /** Optional line number in the "new" file to highlight. */
  highlightNewLine?: number | null
}

/** Renders an array of diff lines with old/new gutters and +/- markers. */
export function DiffView({ lines, highlightNewLine = null }: Props): JSX.Element {
  return (
    <pre className="code-block">
      {lines.map((ln, i) => {
        if (ln.kind === 'gap') {
          return (
            <div key={i} className="code-line gap">
              <span className="gap-text">{ln.text}</span>
            </div>
          )
        }
        const isTarget = ln.newLine !== null && ln.newLine === highlightNewLine
        const sign = ln.kind === 'add' ? '+' : ln.kind === 'del' ? '-' : ' '
        return (
          <div key={i} className={`code-line ${ln.kind}${isTarget ? ' target' : ''}`}>
            <span className="ln">{ln.oldLine ?? ''}</span>
            <span className="ln">{ln.newLine ?? ''}</span>
            <span className="sign">{sign}</span>
            <span className="lc">{ln.text === '' ? ' ' : ln.text}</span>
          </div>
        )
      })}
    </pre>
  )
}
