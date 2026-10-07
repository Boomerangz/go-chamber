import { Children, isValidElement, memo, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ThemedToken } from 'shiki/core'
import { MdLink } from './FileLink'
import CopyButton from './CopyButton'
import ShowAll from './ShowAll'
import MdImage from './MdImage'
import TableBox from './TableBox'
import { useClip } from './useClip'
import { setCodeWrap, useCodeWrap } from './wrap'
import { filePath, MarkLine } from '../../lib/files'
import { pathBreaks } from '../../lib/path'
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

// slashBreaks puts a line-break chance after each slash of a long path in
// a piece of text; anything else passes through.
function slashBreaks(child: ReactNode): ReactNode {
  if (typeof child !== 'string') return child
  const pieces = pathBreaks(child)
  if (pieces.length === 1) return child
  return pieces.flatMap((piece, i) => (i > 0 ? [<wbr key={i} />, piece] : [piece]))
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
  table: ({ children }) => <TableBox>{children}</TableBox>,
  // A long path in a cell's text may break between its folders, so it
  // doesn't take the table's width and crush the words beside it.
  td: ({ style, children }) => {
    const pieces = Children.map(children, slashBreaks)
    const path = pieces?.some((p) => isValidElement(p) && p.type === 'wbr')
    return (
      <td style={style} className={path ? 'md-path' : undefined}>
        {pieces}
      </td>
    )
  },
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
