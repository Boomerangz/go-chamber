import { useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent, type Ref } from 'react'
import type { AgentKind } from '../../lib/api'
import { applyCompletion, completeFiles, filterCommands, findToken, listCommands, type Token } from '../../lib/complete'
import './ComposerInput.css'

interface Option {
  key: string
  label: string
  detail?: string
  insert: string
  dir: boolean
}

interface Props {
  sessionId?: string
  agent?: AgentKind
  value: string
  onChange: (text: string) => void
  onSubmit: () => void
  // onEscape gets Escape when no popup took it (the chat stops a turn with it).
  onEscape?: () => void
  // recall is the text ArrowUp brings back into an empty composer.
  recall?: string
  placeholder: string
  inputRef?: Ref<HTMLTextAreaElement>
}

// Browsers without field-sizing (Firefox) get the box grown by script.
const sizesItself = () => typeof CSS !== 'undefined' && !!CSS.supports?.('field-sizing', 'content')

// ComposerInput is the message box with a completion popup: "@" for files
// in the session folder, "/" (and "$" for Codex) for the agent's commands.
export default function ComposerInput({ sessionId, agent, value, onChange, onSubmit, onEscape, recall, placeholder, inputRef }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useImperativeHandle(inputRef, () => ref.current!, [])
  const listId = useId()
  const [tracked, setToken] = useState<Token | null>(null)
  const [result, setResult] = useState<{ key: string; options: Option[]; failed?: boolean }>({ key: '', options: [] })
  const [active, setActive] = useState(0)
  const caret = useRef<number | null>(null)
  // A cleared composer (after send) has nothing to complete.
  const token = value ? tracked : null
  const key = token ? `${token.kind}:${token.query}` : ''
  // Only show suggestions fetched for the text under the caret right now.
  const answered = !!token && result.key === key
  const options = answered ? result.options : []
  const open = options.length > 0
  // A lookup on its way, or one that found nothing, says so in place of the list.
  const note = !token || open ? null : !answered ? 'searching…' : result.failed ? null : 'no matches'

  const track = (el: HTMLTextAreaElement) =>
    setToken(sessionId ? findToken(el.value, el.selectionStart ?? el.value.length, agent) : null)

  const kind = token?.kind
  const query = token?.query
  useEffect(() => {
    if (!kind || !sessionId) return
    let cancelled = false
    const load = (): Promise<Option[]> =>
      kind === 'file'
        ? completeFiles(sessionId, query ?? '').then((files) =>
            files.map((f) => ({ key: f.path, label: f.path, insert: '@' + f.path, dir: !!f.dir })),
          )
        : listCommands(sessionId).then((cmds) =>
            filterCommands(cmds, query ?? '').map((c) => ({
              key: c.name,
              label: c.insert + (c.argumentHint ? ' ' + c.argumentHint : ''),
              detail: c.description,
              insert: c.insert,
              dir: false,
            })),
          )
    // Files are looked up as the user types; debounce the server round trip.
    const timer = setTimeout(
      () =>
        load().then(
          (next) => {
            if (cancelled) return
            setResult({ key: `${kind}:${query}`, options: next })
            setActive(0)
          },
          () => !cancelled && setResult({ key: `${kind}:${query}`, options: [], failed: true }),
        ),
      kind === 'file' ? 80 : 0,
    )
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [kind, query, sessionId])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || sizesItself()) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value])

  useLayoutEffect(() => {
    const el = ref.current
    if (el && caret.current !== null) {
      el.setSelectionRange(caret.current, caret.current)
      caret.current = null
      track(el)
    }
  })

  const accept = (o: Option) => {
    if (!token) return
    const next = applyCompletion(value, token, o.insert, o.dir)
    caret.current = next.caret
    if (!o.dir) setToken(null)
    onChange(next.text)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open) {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setActive((i) => (i + 1) % options.length)
          return
        case 'ArrowUp':
          e.preventDefault()
          setActive((i) => (i - 1 + options.length) % options.length)
          return
        case 'Tab':
        case 'Enter':
          if (e.metaKey || e.ctrlKey || e.shiftKey) break
          e.preventDefault()
          accept(options[active])
          return
        case 'Escape':
          e.preventDefault()
          setToken(null)
          return
      }
    }
    if (e.key === 'Escape' && note) {
      e.preventDefault()
      setToken(null)
      return
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      onSubmit()
      return
    }
    if (e.key === 'Escape' && onEscape) {
      onEscape()
      return
    }
    if (e.key === 'ArrowUp' && !value && recall && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      caret.current = recall.length
      onChange(recall)
    }
  }

  const optionId = (i: number) => `${listId}-${i}`
  return (
    <div className="composer-input">
      {open && (
        <ul className="completions" role="listbox" id={listId} aria-label={kind === 'file' ? 'files' : 'commands'}>
          {options.map((o, i) => (
            <li
              key={o.key}
              id={optionId(i)}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : undefined}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => accept(o)}
            >
              <span className="completion-label">{o.label}</span>
              {o.detail && <span className="completion-detail">{o.detail}</span>}
            </li>
          ))}
        </ul>
      )}
      {note && (
        <div className={`completions completions-note${answered ? '' : ' searching'}`} role="status">
          {note}
        </div>
      )}
      <textarea
        ref={ref}
        aria-label="message"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? optionId(active) : undefined}
        value={value}
        rows={1}
        onChange={(e) => {
          onChange(e.target.value)
          track(e.target)
        }}
        onSelect={(e) => track(e.currentTarget)}
        onBlur={() => setToken(null)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
      />
    </div>
  )
}
