import { memo, useEffect, useState, type CSSProperties } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ThemedToken } from 'shiki/core'
import { MdLink } from './FileLink'
import { filePath } from '../../lib/files'

const urlTransform: UrlTransform = (url, key, node) => {
  if (key === 'href' && node.tagName === 'a' && url.startsWith('file://') && filePath(url) !== null) return url
  return defaultUrlTransform(url)
}

// HIGHLIGHT_DELAY_MS lets a block streaming in settle before it is coloured:
// tokenizing the whole block on every flush is quadratic in its length.
const HIGHLIGHT_DELAY_MS = 250

// CodeBlock shows the code at once and colours it when the grammar arrives
// and the code stops changing.
function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [highlighted, setHighlighted] = useState<{ code: string; tokens?: ThemedToken[][] }>()
  const tokens = highlighted?.code === code ? highlighted.tokens : undefined
  useEffect(() => {
    if (!lang) return
    let live = true
    const timer = setTimeout(() => {
      import('../../lib/highlight')
        .then(({ tokenize }) => tokenize(code, lang))
        .then((t) => live && setHighlighted({ code, tokens: t }))
        .catch(() => {})
    }, highlighted ? HIGHLIGHT_DELAY_MS : 0)
    return () => {
      live = false
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the first colouring is immediate
  }, [code, lang])
  return (
    <pre className="md-code" data-lang={lang}>
      <code>
        {tokens
          ? tokens.map((line, i) => (
              <span key={i} className="md-line">
                {line.map((t, j) => (
                  <span key={j} style={t.htmlStyle as CSSProperties}>
                    {t.content}
                  </span>
                ))}
                {'\n'}
              </span>
            ))
          : code}
      </code>
    </pre>
  )
}

const components: Components = {
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const text = String(children ?? '')
    const lang = /language-(\S+)/.exec(className ?? '')?.[1]
    if (!lang && !text.includes('\n')) return <code>{children}</code>
    return <CodeBlock code={text.replace(/\n$/, '')} lang={lang} />
  },
  a: ({ href, children }) => <MdLink href={href}>{children}</MdLink>,
}

// Markdown renders agent text; raw HTML is dropped (skipHtml, no rehype-raw).
function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={urlTransform} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  )
}

export default memo(Markdown)
