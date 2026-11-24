import { create } from 'zustand'
import { DEFAULT_SCHEME, findScheme, tokens } from '../lib/schemes'

// Appearance is the owner's reading setup: the sheet, the transcript's type
// size and its measure. Each is a data attribute on the page's root, which the
// stylesheet reads; the defaults leave the root bare.
export type Theme = 'system' | 'light' | 'dark'
export type TextSize = 'small' | 'default' | 'large'

interface Appearance {
  theme: Theme
  // scheme is the colour scheme within the sheet; Chamber is the stylesheet's own.
  scheme: string
  text: TextSize
  // wide lets the transcript run past the reading measure.
  wide: boolean
  agentIcons: 'mono' | 'color'
  // smoothing leaves the page's glyphs to the system's font smoothing
  // rather than the thinner antialiasing; termSmoothing does so for the
  // terminal, apart from the page.
  smoothing: boolean
  // termSmoothing leaves the terminal's glyphs to the system's smoothing
  // rather than the page's thinner antialiasing.
  termSmoothing: boolean
}

interface AppearanceStore extends Appearance {
  setTheme: (theme: Theme) => void
  setScheme: (scheme: string) => void
  setText: (text: TextSize) => void
  setAgentIcons: (agentIcons: 'mono' | 'color') => void
  setWide: (wide: boolean) => void
  setSmoothing: (smoothing: boolean) => void
  setTermSmoothing: (termSmoothing: boolean) => void
}

const KEY = 'gc.appearance'
const defaults: Appearance = { theme: 'system', scheme: DEFAULT_SCHEME, text: 'default', wide: false, agentIcons: 'mono', smoothing: true, termSmoothing: true }

export function loadAppearance(): Appearance {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>
    return {
      theme: raw.theme === 'light' || raw.theme === 'dark' ? raw.theme : 'system',
      scheme: typeof raw.scheme === 'string' && findScheme(raw.scheme) ? raw.scheme : DEFAULT_SCHEME,
      text: raw.text === 'small' || raw.text === 'large' ? raw.text : 'default',
      wide: raw.wide === true,
      agentIcons: raw.agentIcons === 'color' ? 'color' : 'mono',
      smoothing: raw.smoothing !== false,
      termSmoothing: raw.termSmoothing !== false,
    }
  } catch {
    return { ...defaults }
  }
}

function systemDark(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches
}

const painted = new Set<string>()

function apply({ theme, scheme, text, wide, agentIcons, smoothing, termSmoothing }: Appearance) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const data = root.dataset
  if (theme === 'system') delete data.theme
  else data.theme = theme
  if (text === 'default') delete data.text
  else data.text = text
  if (agentIcons === 'color') data.agentIcons = 'color'
  else delete data.agentIcons
  if (wide) data.wide = ''
  else delete data.wide
  if (smoothing) delete data.antialiased
  else data.antialiased = ''
  if (termSmoothing) delete data.termAntialiased
  else data.termAntialiased = ''
  for (const name of painted) root.style.removeProperty(name)
  painted.clear()
  const found = scheme === DEFAULT_SCHEME ? undefined : findScheme(scheme)
  if (!found) {
    delete data.scheme
    return
  }
  data.scheme = found.id
  const dark = theme === 'system' ? systemDark() : theme === 'dark'
  for (const [name, value] of Object.entries(tokens(dark ? found.dark : found.light))) {
    root.style.setProperty(name, value)
    painted.add(name)
  }
  root.style.setProperty('color-scheme', dark ? 'dark' : 'light')
  painted.add('color-scheme')
}

export const useAppearanceStore = create<AppearanceStore>((set, get) => {
  const update = (patch: Partial<Appearance>) => {
    const { theme, scheme, text, wide, agentIcons, smoothing, termSmoothing } = { ...get(), ...patch }
    const next = { theme, scheme, text, wide, agentIcons, smoothing, termSmoothing }
    // the page is painted before subscribers look at its tokens
    apply(next)
    set(patch)
    try {
      localStorage.setItem(KEY, JSON.stringify(next))
    } catch {
      // storage unavailable: the choice lasts for this page only
    }
  }
  const initial = loadAppearance()
  apply(initial)
  // a scheme follows the system sheet when the owner left it to the system
  if (typeof window !== 'undefined')
    window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
      const { theme, scheme } = get()
      if (theme !== 'system' || scheme === DEFAULT_SCHEME) return
      apply(get())
      set({}) // lets terminals re-read the page
    })
  return {
    ...initial,
    setTheme: (theme) => update({ theme }),
    setScheme: (scheme) => update({ scheme }),
    setText: (text) => update({ text }),
    setAgentIcons: (agentIcons) => update({ agentIcons }),
    setWide: (wide) => update({ wide }),
    setSmoothing: (smoothing) => update({ smoothing }),
    setTermSmoothing: (termSmoothing) => update({ termSmoothing }),
  }
})

// isDark says whether the page is on the dark sheet: the owner's choice, or
// the system's when they left it to the system.
export function isDark(): boolean {
  const theme = useAppearanceStore.getState().theme
  return theme === 'system' ? systemDark() : theme === 'dark'
}

export function resetAppearance() {
  const initial = loadAppearance()
  useAppearanceStore.setState(initial)
  apply(initial)
}
