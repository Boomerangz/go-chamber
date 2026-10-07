import { useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type Ref } from 'react'
import type { AgentKind } from '../../lib/api'
import { applyCompletion, completeFiles, filterCommands, findToken, listCommands, type Token } from '../../lib/complete'
import { failedTo } from '../../lib/failed'
import { describeError } from '../../stores/notices'
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
  // history is what the owner sent in this session, oldest first: ArrowUp
  // walks back through it, ArrowDown forward and then to the draft.
  history?: string[]
  placeholder: string
  // enterSends: Enter sends and Shift+Enter breaks the line. Off on touch
  // screens, where Enter is the keyboard's newline and Send is a tap away.
  // ⌘↵ / Ctrl+↵ sends either way.
  enterSends?: boolean
  inputRef?: Ref<HTMLTextAreaElement>
}

// Walk is a trip through the sent messages: which one shows, and the draft
// to come back to. Editing the shown message ends the trip.
interface Walk {
  index: number
  draft: string
  shown: string
}

// Browsers without field-sizing (Firefox) get the box grown by script.
const sizesItself = () => typeof CSS !== 'undefined' && !!CSS.supports?.('field-sizing', 'content')

// ComposerInput is the message box with a completion popup: "@" for files
// in the session folder, "/" (and "$" for Codex) for the agent's commands.
export default function ComposerInput({ sessionId, agent, value, onChange, onSubmit, onEscape, history, placeholder, enterSends = true, inputRef }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useImperativeHandle(inputRef, () => ref.current!, [])
  const listId = useId()
  const [tracked, setToken] = useState<Token | null>(null)
  const [result, setResult] = useState<{ key: string; options: Option[]; failed?: string }>({ key: '', options: [] })
  const [active, setActive] = useState(0)
  const caret = useRef<number | null>(null)
  // A cleared composer (after send) has nothing to complete.
  const token = value ? tracked : null
  const key = token ? `${token.kind}:${token.query}` : ''
  // Show suggestions fetched for the text under the caret right now; while
  // the next lookup runs, the last ones of the same kind stay, dimmed, so the
  // list doesn't blink with every key.
  const answered = !!token && result.key === key
  const stale = !!token && !answered && result.failed === undefined && result.key.startsWith(`${token.kind}:`) && result.options.length > 0
  const options = answered || stale ? result.options : []
  const open = options.length > 0
  // A lookup on its way, one that found nothing, or one that failed says so
  // in place of the list.
  const note = !token || open
    ? null
    : !answered
      ? 'searching…'
      : result.failed !== undefined
        ? failedTo(`list ${token.kind === 'file' ? 'files' : 'commands'}`, result.failed)
        : 'no matches'
  const [walk, setWalk] = useState<Walk | null>(null)
  const sent = useMemo(() => (history ?? []).filter((t) => t), [history])
  // A walk lasts while its message shows unedited.
  const walking = walk && walk.shown === value ? walk : null

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
          (err: unknown) => !cancelled && setResult({ key: `${kind}:${query}`, options: [], failed: describeError(err) }),
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
    if (!token || !answered) return
    const next = applyCompletion(value, token, o.insert, o.dir)
    caret.current = next.caret
    if (!o.dir) setToken(null)
    onChange(next.text)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // The IME owns navigation and commit keys, even with suggestions open.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
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
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      const modified = e.metaKey || e.ctrlKey
      if (modified || enterSends) {
        e.preventDefault()
        // Suggestions still on their way: Enter waits for them, not sends.
        if (!modified && note === 'searching…') return
        onSubmit()
        return
      }
    }
    if (e.key === 'Escape' && onEscape) {
      onEscape()
      return
    }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) walkHistory(e)
  }

  // walkHistory is the shell's history: ArrowUp at the start of the box (or
  // on the first line of a recalled message) goes back, ArrowDown on the last
  // line goes forward and finally back to the draft.
  const walkHistory = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget
    const from = el.selectionStart ?? 0
    const to = el.selectionEnd ?? 0
    const show = (index: number, draft: string) => {
      const text = sent[index]!
      setWalk({ index, draft, shown: text })
      caret.current = text.length
      onChange(text)
    }
    if (e.key === 'ArrowUp') {
      const firstLine = walking ? !value.slice(0, from).includes('\n') : from === 0 && to === 0
      if (!firstLine || !sent.length) return
      e.preventDefault()
      const index = (walking ? walking.index : sent.length) - 1
      if (index >= 0) show(index, walking ? walking.draft : value)
      return
    }
    if (!walking || value.slice(to).includes('\n')) return
    e.preventDefault()
    if (walking.index + 1 < sent.length) {
      show(walking.index + 1, walking.draft)
      return
    }
    setWalk(null)
    caret.current = walking.draft.length
    onChange(walking.draft)
  }

  const optionId = (i: number) => `${listId}-${i}`
  return (
    <div className="composer-input">
      {open && (
        <ul
          className={stale ? 'completions stale' : 'completions'}
          role="listbox"
          id={listId}
          aria-label={kind === 'file' ? 'Files' : 'Commands'}
          aria-busy={stale || undefined}
        >
          {options.map((o, i) => (
            <li
              key={o.key}
              id={optionId(i)}
              role="option"
              aria-disabled={stale || undefined}
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
        aria-label="Message"
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
