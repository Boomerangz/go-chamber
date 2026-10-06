import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ClipboardPaste, Search } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { keySequence, type SpecialKey } from '../../lib/terminal-input'
import { fail } from '../../stores/notices'
import { useTerminalStore } from '../../stores/terminals'
import { icon } from '../icon'
import { pasteInto, sendKeys, setStickyCtrl } from './live'

const keys: { key: SpecialKey; label: string; content: ReactNode }[] = [
  { key: 'esc', label: 'Escape', content: 'Esc' },
  { key: 'tab', label: 'Tab', content: 'Tab' },
]
const arrows: { key: SpecialKey; label: string; content: ReactNode }[] = [
  { key: 'left', label: 'Left', content: <ArrowLeft {...icon(14)} /> },
  { key: 'up', label: 'Up', content: <ArrowUp {...icon(14)} /> },
  { key: 'down', label: 'Down', content: <ArrowDown {...icon(14)} /> },
  { key: 'right', label: 'Right', content: <ArrowRight {...icon(14)} /> },
]
// The second group: characters awkward to reach on a phone keyboard, then
// the paging keys and end-of-input.
const chars = ['|', '~', '/', '-']
const paging: { key: SpecialKey; label: string; content: ReactNode }[] = [
  { key: 'home', label: 'Home', content: 'Home' },
  { key: 'end', label: 'End', content: 'End' },
  { key: 'pgup', label: 'Page up', content: 'PgUp' },
  { key: 'pgdn', label: 'Page down', content: 'PgDn' },
  { key: 'eof', label: 'End of input', content: '^D' },
]

// keep focus in the terminal: a tap on a key must not close the keyboard.
const keepFocus = (e: React.PointerEvent | React.MouseEvent) => e.preventDefault()

// TerminalKeys is the row of keys a phone keyboard lacks. It shows only on
// touch screens (CSS: pointer: coarse) and types through the same input path
// as the keyboard, so keys pressed while reconnecting are held, not lost.
export default function TerminalKeys({ id }: { id: string }) {
  const [ctrl, setCtrl] = useState(false)
  const setFinding = useTerminalStore((s) => s.setFinding)
  useEffect(() => () => setStickyCtrl(id, false, () => {}), [id])
  const press = (key: SpecialKey) => sendKeys(id, keySequence(key))
  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (text) pasteInto(id, text)
    } catch (err) {
      fail('Paste failed', err)
    }
  }
  const button = ({ key, label, content }: (typeof keys)[number]) => (
    <button key={key} type="button" className="btn btn-xs" aria-label={label} title={label} onPointerDown={keepFocus} onMouseDown={keepFocus} onClick={() => press(key)}>
      {content}
    </button>
  )
  return (
    <div className="term-keys" role="toolbar" aria-label="Terminal keys">
      {keys.map(button)}
      <button
        type="button"
        className="btn btn-xs"
        aria-pressed={ctrl}
        aria-label="Control"
        title="Control: applies to the next key"
        onPointerDown={keepFocus}
        onMouseDown={keepFocus}
        onClick={() => {
          const next = !ctrl
          setCtrl(next)
          setStickyCtrl(id, next, () => setCtrl(false))
        }}
      >
        Ctrl
      </button>
      {arrows.map(button)}
      <button type="button" className="btn btn-xs" aria-label="Interrupt" title="Interrupt (Ctrl-C)" onPointerDown={keepFocus} onMouseDown={keepFocus} onClick={() => press('interrupt')}>
        ^C
      </button>
      <button type="button" className="btn btn-xs" aria-label="Paste" title="Paste" onPointerDown={keepFocus} onMouseDown={keepFocus} onClick={() => void paste()}>
        <ClipboardPaste {...icon(14)} />
      </button>
      <span className="term-keys-gap" aria-hidden="true" />
      {chars.map((ch) => (
        <button key={ch} type="button" className="btn btn-xs" aria-label={`Type ${ch}`} title={ch} onPointerDown={keepFocus} onMouseDown={keepFocus} onClick={() => sendKeys(id, ch)}>
          {ch}
        </button>
      ))}
      {paging.map(button)}
      <button type="button" className="btn btn-xs" aria-label="Find" title="Find in scrollback" onClick={() => setFinding(id, true)}>
        <Search {...icon(14)} />
      </button>
    </div>
  )
}
