import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ClipboardPaste } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { keySequence, type SpecialKey } from '../../lib/terminal-input'
import { fail } from '../../stores/notices'
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

// keep focus in the terminal: a tap on a key must not close the keyboard.
const keepFocus = (e: React.PointerEvent | React.MouseEvent) => e.preventDefault()

// TerminalKeys is the row of keys a phone keyboard lacks. It shows only on
// touch screens (CSS: pointer: coarse) and types through the same input path
// as the keyboard, so keys pressed while reconnecting are held, not lost.
export default function TerminalKeys({ id }: { id: string }) {
  const [ctrl, setCtrl] = useState(false)
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
    </div>
  )
}
