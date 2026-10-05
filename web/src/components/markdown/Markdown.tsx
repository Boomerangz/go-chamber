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

// CodeBlock shows the code at once and colours it when the grammar arrives.
function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [tokens, setTokens] = useState<ThemedToken[][]>()
  useEffect(() => {
    if (!lang) return
    let live = true
    import('../../lib/highlight')
      .then(({ tokenize }) => tokenize(code, lang))
      .then((t) => live && setTokens(t))
      .catch(() => {})
    return () => {
      live = false
    }
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
