import { Webhook, WebhookOff } from 'lucide-react'
import type { Hooks } from '../../lib/tree'
import { useLayoutStore } from '../../stores/layout'
import { icon } from '../icon'

const next: Record<Hooks, Hooks> = { some: 'all', all: 'off', off: 'some' }
const titles: Record<Hooks, string> = {
  some: 'Hooks that said something are shown; click for all hooks',
  all: 'All hooks are shown; click to hide them',
  off: 'Hooks are hidden, failed ones aside; click for hooks that said something',
}
const pressed: Record<Hooks, boolean | 'mixed'> = { some: 'mixed', all: true, off: false }
const words: Record<Hooks, string> = { some: 'hooks that spoke', all: 'all hooks', off: 'no hooks' }

// HooksToggle steps through how many hook runs the transcript shows; it
// sits with the app-wide things in the sessions sidebar's footer.
export default function HooksToggle() {
  const hooks = useLayoutStore((s) => s.hooks)
  const setHooks = useLayoutStore((s) => s.setHooks)
  return (
    <button
      type="button"
      className="btn btn-ghost btn-xs hooks-toggle"
      aria-label="Hooks"
      aria-pressed={pressed[hooks]}
      title={titles[hooks]}
      onClick={() => setHooks(next[hooks])}
    >
      {hooks === 'off' ? <WebhookOff {...icon(13)} /> : <Webhook {...icon(13)} />}
      <span aria-hidden="true">Transcript: {words[hooks]}</span>
    </button>
  )
}
