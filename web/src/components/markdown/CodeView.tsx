import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { ThemedToken } from 'shiki/core'

// CodeView shows a text file in the viewer: numbered lines, coloured once
// the grammar loads, with the line a link points at marked and in view.
export default function CodeView({ text, lang, mark }: { text: string; lang?: string; mark?: number }) {
  const lines = useMemo(() => text.replace(/\n$/, '').split('\n'), [text])
  const [tokens, setTokens] = useState<{ text: string; lines: ThemedToken[][] }>()
  useEffect(() => {
    if (!lang) return
    let live = true
    import('../../lib/highlight')
      .then(({ tokenize }) => tokenize(text, lang))
      .then((t) => live && t && setTokens({ text, lines: t }))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [text, lang])
  const coloured = tokens?.text === text ? tokens.lines : undefined
  const marked = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    marked.current?.scrollIntoView?.({ block: 'center' })
  }, [mark, coloured])
  const style = { '--ln': `${String(lines.length).length}ch` } as CSSProperties
  return (
    <pre className="fv-code" data-lang={lang} style={style}>
      <code>
        {lines.map((line, i) => (
          <span key={i} className={i + 1 === mark ? 'fv-line fv-line-mark' : 'fv-line'} ref={i + 1 === mark ? marked : undefined}>
            <span className="fv-ln" aria-hidden="true">{i + 1}</span>
            <span className="fv-text">{colour(line, coloured?.[i])}</span>
            {'\n'}
          </span>
        ))}
      </code>
    </pre>
  )
}

function colour(text: string, tokens: ThemedToken[] | undefined): ReactNode {
  if (!tokens) return text
  return tokens.map((t, j) => (
    <span key={j} style={t.htmlStyle as CSSProperties}>
      {t.content}
    </span>
  ))
}
