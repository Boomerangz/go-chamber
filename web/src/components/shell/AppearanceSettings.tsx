import { ChevronDown } from 'lucide-react'
import { type TextSize, type Theme, useAppearanceStore } from '../../stores/appearance'
import type { Hooks } from '../../lib/tree'
import { useLayoutStore } from '../../stores/layout'
import { icon } from '../icon'

const themes: [Theme, string][] = [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']]
const sizes: [TextSize, string][] = [['small', 'Small'], ['default', 'Default'], ['large', 'Large']]
// hooks: the ones that stopped the agent or failed, every run, or none but failures
const hookChoices: [Hooks, string][] = [['some', 'Objected'], ['all', 'All'], ['off', 'None']]

function Choice<T extends string>(props: { label: string; options: [T, string][]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="appearance-row">
      <span className="appearance-label">{props.label}</span>
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

// AppearanceSettings is the owner's reading setup, folded in the sessions
// sidebar's footer with the other app-wide things.
export default function AppearanceSettings() {
  const { theme, text, wide, setTheme, setText, setWide } = useAppearanceStore()
  const hooks = useLayoutStore((s) => s.hooks)
  const setHooks = useLayoutStore((s) => s.setHooks)
  return (
    <details className="appearance">
      <summary>
        <ChevronDown {...icon(14)} className="icon chevron" />
        Appearance
      </summary>
      <Choice label="Theme" options={themes} value={theme} onChange={setTheme} />
      <Choice label="Text" options={sizes} value={text} onChange={setText} />
      <Choice label="Hooks" options={hookChoices} value={hooks} onChange={setHooks} />
      <label className="appearance-wide">
        <input type="checkbox" checked={wide} onChange={(e) => setWide(e.target.checked)} />
        Wide transcript
      </label>
    </details>
  )
}
