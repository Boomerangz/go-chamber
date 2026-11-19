import { Check, Smile, X } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { titleEmoji, withTitleEmoji } from '../../lib/titleEmoji'
import { icon } from '../icon'
import { matches } from '../chat/useMedia'
import { emojiGroups } from './emoji'
import './TitleField.css'

interface Props {
  value: string
  label: string
  onChange: (value: string) => void
  onSave: (keyboard: boolean) => void
  onCancel: () => void
  saveOnBlur?: boolean
  className?: string
}

// One focus boundary for the name, emoji palette and save button. Moving
// between them must never commit an unfinished rename.
export default function TitleField({ value, label, onChange, onSave, onCancel, saveOnBlur, className = '' }: Props) {
  const [open, setOpen] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const id = useId()
  const selected = titleEmoji(value)

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  const choose = (emoji: string) => {
    const next = withTitleEmoji(value, emoji)
    onChange(next)
    setOpen(false)
    input.current?.focus()
    // Focus returns without selecting the whole title: typing can continue.
    requestAnimationFrame(() => input.current?.setSelectionRange(next.length, next.length))
  }

  return (
    <span
      className={`title-field ${className}`}
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget)) return
        setOpen(false)
        if (saveOnBlur) onSave(false)
      }}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing || e.keyCode === 229) { e.stopPropagation(); return }
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          if (open) {
            setOpen(false)
            trigger.current?.focus()
          } else onCancel()
        }
      }}
    >
      <input
        ref={input}
        className="title-input"
        aria-label={label}
        value={value}
        maxLength={200}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return
          if (e.key === 'Enter') {
            e.preventDefault()
            onSave(true)
          }
        }}
      />
      <button
        ref={trigger}
        type="button"
        className="title-emoji-trigger"
        aria-label={selected ? 'Change title emoji' : 'Choose title emoji'}
        title={selected ? 'Change title emoji' : 'Add an emoji to the start'}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        {selected ? <span aria-hidden="true">{selected}</span> : <Smile {...icon(18)} />}
      </button>
      <button type="button" className="title-save" aria-label="Save name" title="Save name · Enter" onClick={() => onSave(true)}>
        <Check {...icon(16)} />
      </button>
      {open && <EmojiPalette id={id} value={value} trigger={trigger} onChoose={choose} onClose={() => { setOpen(false); trigger.current?.focus() }} />}
    </span>
  )
}

function EmojiPalette({ id, value, trigger, onChoose, onClose }: {
  id: string
  value: string
  trigger: RefObject<HTMLButtonElement | null>
  onChoose: (emoji: string) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const palette = useRef<HTMLSpanElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const [pos, setPos] = useState({ left: 0, top: 0 })
  const selected = titleEmoji(value)
  const words = query.trim().toLocaleLowerCase().split(/\s+/)
  const groups = emojiGroups.map((group) => ({ ...group, items: group.items.filter((item) => words.every((word) => item.join(' ').toLocaleLowerCase().includes(word))) }))
  const count = groups.reduce((n, group) => n + group.items.length, 0)

  useLayoutEffect(() => {
    let lastLeft = -1
    let lastTop = -1
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect()
      const sheet = palette.current
      if (!anchor || !sheet) return
      const view = window.visualViewport
      const left = view?.offsetLeft ?? 0
      const top = view?.offsetTop ?? 0
      const width = view?.width ?? window.innerWidth
      const height = view?.height ?? window.innerHeight
      sheet.style.maxHeight = `${Math.max(0, height - 24)}px`
      const rect = sheet.getBoundingClientRect()
      const next = {
        left: Math.max(left + 12, Math.min(anchor.left, left + width - rect.width - 12)),
        top: Math.max(top + 12, Math.min(anchor.bottom + 6, top + height - rect.height - 12)),
      }
      if (next.left !== lastLeft || next.top !== lastTop) {
        lastLeft = next.left
        lastTop = next.top
        setPos(next)
      }
    }
    place()
    // Focus can hide/show the phone's chrome without a viewport resize.
    // Follow the anchor while open, including those layout-only movements.
    let frame = requestAnimationFrame(function follow() {
      place()
      frame = requestAnimationFrame(follow)
    })
    return () => cancelAnimationFrame(frame)
  }, [trigger])

  useEffect(() => {
    // Let a phone hide its typing keyboard so the palette gets the room.
    if (matches('(pointer: coarse)')) palette.current?.querySelector<HTMLButtonElement>('.emoji-choice')?.focus()
    else search.current?.focus()
  }, [])

  return (
    <span ref={palette} id={id} tabIndex={-1} className="title-emoji-palette" role="dialog" aria-label="Title emoji" style={pos}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing || e.keyCode === 229) return
        // Session menus close on Tab: this inner picker owns its keys.
        e.stopPropagation()
        if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
        const choices = [...(palette.current?.querySelectorAll<HTMLButtonElement>('.emoji-choice:not(:disabled)') ?? [])]
        const at = choices.indexOf(document.activeElement as HTMLButtonElement)
        if (e.target === search.current) {
          if (e.key === 'ArrowDown') { e.preventDefault(); choices[0]?.focus() }
          return
        }
        if (at < 0) return
        const next = { ArrowRight: at + 1, ArrowLeft: at - 1, ArrowDown: at + 8, ArrowUp: at - 8, Home: 0, End: choices.length - 1 }[e.key]
        if (next === undefined) return
        e.preventDefault()
        choices[Math.max(0, Math.min(next, choices.length - 1))]?.focus()
      }}>
      <span className="emoji-palette-heading">
        <strong>Title emoji</strong>
        <button type="button" aria-label="Close emoji picker" onClick={onClose}><X {...icon(16)} /></button>
      </span>
      <span className="emoji-palette-hint">One emoji at the start of your name.</span>
      <input ref={search} type="search" className="field" aria-label="Search emoji" placeholder="Search emoji / Поиск" value={query} onChange={(e) => setQuery(e.target.value)} />
      <span className="emoji-palette-scroll">
        {groups.filter((group) => group.items.length).map((group) => (
          <span key={group.name} className="emoji-group" role="group" aria-label={group.name}>
            <span className="emoji-group-name">{group.name}</span>
            <span className="emoji-grid">
              {group.items.map(([emoji, name]) => (
                <button key={emoji} type="button" className="emoji-choice" aria-label={`${emoji} ${name}`} title={name}
                  aria-pressed={selected === emoji} disabled={withTitleEmoji(value, emoji).length > 200} onClick={() => onChoose(emoji)}>{emoji}</button>
              ))}
            </span>
          </span>
        ))}
        {count === 0 && <span className="emoji-empty" role="status">No emoji found. Try another word.</span>}
      </span>
      <span className="emoji-palette-footer">
        <button type="button" disabled={!selected} onClick={() => onChoose('')}>Remove emoji</button>
        <span>{value.length > 196 ? 'Shorten the name to add an emoji.' : 'Esc to close'}</span>
      </span>
    </span>
  )
}
