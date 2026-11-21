import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { type TextSize, type Theme, isDark, useAppearanceStore } from '../../stores/appearance'
import { DEFAULT_SCHEME, schemes } from '../../lib/schemes'
import type { Hooks } from '../../lib/tree'
import { useLayoutStore } from '../../stores/layout'
import { icon } from '../icon'
import './shell.css'

const modes: [Theme, string][] = [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']]
const sizes: [TextSize, string][] = [['small', 'Small'], ['default', 'Default'], ['large', 'Large']]
// hooks: the ones that stopped the agent or failed, every run, or none but failures
const hookChoices: [Hooks, string][] = [['some', 'Objected'], ['all', 'All'], ['off', 'None']]

function Choice<T extends string>(props: { label: string; options: [T, string][]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="settings-row">
      <span className="settings-label">{props.label}</span>
      <div className="segmented" role="radiogroup" aria-label={props.label}>
        {props.options.map(([v, word]) => (
          <button key={v} type="button" role="radio" aria-checked={props.value === v} onClick={() => props.onChange(v)}>
            {word}
          </button>
        ))}
      </div>
    </div>
  )
}

// Each card previews its scheme on the sheet in use, in its own colours.
function Schemes() {
  const { scheme, theme, setScheme } = useAppearanceStore()
  const dark = theme === 'system' ? isDark() : theme === 'dark'
  const cards = [
    { id: DEFAULT_SCHEME, name: 'Chamber', p: null },
    ...schemes.map((s) => ({ id: s.id, name: s.name, p: dark ? s.dark : s.light })),
  ]
  return (
    <div className="scheme-grid" role="radiogroup" aria-label="Color scheme">
      {cards.map(({ id, name, p }) => (
        <button key={id} type="button" role="radio" aria-checked={scheme === id} className="scheme-card" onClick={() => setScheme(id)}>
          <span
            className="scheme-swatch"
            data-default={p ? undefined : ''}
            style={p ? { background: p.paper, color: p.ink, borderColor: p.rule } : undefined}
          >
            <span>Aa</span>
            <i style={p ? { background: p.act } : undefined} />
            <i style={p ? { background: p.req } : undefined} />
            <i style={p ? { background: p.bad } : undefined} />
          </span>
          <span className="scheme-name">{name}</span>
        </button>
      ))}
    </div>
  )
}

// SettingsDialog is the owner's setup, over the app: how the page looks and
// what the transcript shows. It opens from the sidebar footer or with a comma.
export default function SettingsDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const { theme, text, wide, agentIcons, setTheme, setText, setWide, setAgentIcons } = useAppearanceStore()
  const hooks = useLayoutStore((s) => s.hooks)
  const setHooks = useLayoutStore((s) => s.setHooks)
  useEffect(() => {
    const d = ref.current
    if (d && !d.open) d.showModal()
  }, [])
  return (
    <dialog
      ref={ref}
      className="settings"
      aria-label="Settings"
      onClose={onClose}
      onCancel={onClose}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <header className="shortcut-head">
        <h2>Settings</h2>
        <button type="button" className="btn btn-ghost btn-icon" aria-label="Close" title="Close" onClick={onClose} autoFocus>
          <X {...icon(16)} />
        </button>
      </header>
      <div className="settings-body">
        <section aria-label="Appearance">
          <h3 className="section-title">Appearance</h3>
          <Choice label="Sheet" options={modes} value={theme} onChange={setTheme} />
          <div className="settings-row settings-row-top">
            <span className="settings-label">Color scheme</span>
            <Schemes />
          </div>
          <Choice label="Agent icons" options={[['mono', 'Monochrome'], ['color', 'Color']]} value={agentIcons} onChange={setAgentIcons} />
          <Choice label="Text" options={sizes} value={text} onChange={setText} />
          <label className="settings-check">
            <input type="checkbox" checked={wide} onChange={(e) => setWide(e.target.checked)} />
            Wide transcript
          </label>
        </section>
        <section aria-label="Transcript">
          <h3 className="section-title">Transcript</h3>
          <Choice label="Hooks" options={hookChoices} value={hooks} onChange={setHooks} />
        </section>
      </div>
    </dialog>
  )
}
