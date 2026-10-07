import { memo, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ThemedToken } from 'shiki/core'
import { MdLink } from './FileLink'
import CopyButton from './CopyButton'
import ShowAll from './ShowAll'
import MdImage from './MdImage'
import { useClip } from './useClip'
import { setCodeWrap, useCodeWrap } from './wrap'
import { filePath, MarkLine } from '../../lib/files'
import './Markdown.css'

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
  const mark = useContext(MarkLine)
  const marked = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    marked.current?.scrollIntoView?.({ block: 'center' })
  }, [mark, tokens])
  // Lines are spans of their own once coloured, or when one must be marked.
  const lines: ReactNode[][] | undefined = tokens
    ? tokens.map((line) => line.map((t, j) => (
        <span key={j} style={t.htmlStyle as CSSProperties}>
          {t.content}
        </span>
      )))
    : mark
      ? code.split('\n').map((line) => [line])
      : undefined
  const wrap = useCodeWrap()
  const [box, clip] = useClip<HTMLPreElement>([code, wrap])
  const count = code.split('\n').length
  const classes = ['md-code', wrap && 'md-code-wrap', clip.full && 'full'].filter(Boolean).join(' ')
  return (
    <div className="md-codeblock">
      <div className="md-code-bar">
        <span className="md-code-lang">{lang ?? 'text'}</span>
        <span className="md-code-tools">
          <button
            type="button"
            className="btn btn-ghost btn-xs md-code-wrap-toggle"
            aria-pressed={wrap}
            title={wrap ? 'Keep long lines on one line' : 'Wrap long lines'}
            onClick={() => setCodeWrap(!wrap)}
          >
            Wrap
          </button>
          <CopyButton text={code} />
        </span>
      </div>
      <pre ref={box} className={classes} data-lang={lang}>
        <code>
          {lines
            ? lines.map((line, i) => (
                <span
                  key={i}
                  className={i + 1 === mark ? 'md-line md-line-mark' : 'md-line'}
                  ref={i + 1 === mark ? marked : undefined}
                >
                  {line}
                  {'\n'}
                </span>
              ))
            : code}
        </code>
      </pre>
      <ShowAll clip={clip} lines={count} />
    </div>
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
  img: ({ src, alt }) => <MdImage src={typeof src === 'string' ? src : undefined} alt={alt} />,
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
