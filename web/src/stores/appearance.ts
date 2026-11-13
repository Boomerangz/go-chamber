import { create } from 'zustand'

// Appearance is the owner's reading setup: the sheet, the transcript's type
// size and its measure. Each is a data attribute on the page's root, which the
// stylesheet reads; the defaults leave the root bare.
export type Theme = 'system' | 'light' | 'dark'
export type TextSize = 'small' | 'default' | 'large'

interface Appearance {
  theme: Theme
  text: TextSize
  // wide lets the transcript run past the reading measure.
  wide: boolean
}

interface AppearanceStore extends Appearance {
  setTheme: (theme: Theme) => void
  setText: (text: TextSize) => void
  setWide: (wide: boolean) => void
}

const KEY = 'gc.appearance'
const defaults: Appearance = { theme: 'system', text: 'default', wide: false }

export function loadAppearance(): Appearance {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>
    return {
      theme: raw.theme === 'light' || raw.theme === 'dark' ? raw.theme : 'system',
      text: raw.text === 'small' || raw.text === 'large' ? raw.text : 'default',
      wide: raw.wide === true,
    }
  } catch {
    return { ...defaults }
  }
}

function apply({ theme, text, wide }: Appearance) {
  if (typeof document === 'undefined') return
  const root = document.documentElement.dataset
  if (theme === 'system') delete root.theme
  else root.theme = theme
  if (text === 'default') delete root.text
  else root.text = text
  if (wide) root.wide = ''
  else delete root.wide
}

export const useAppearanceStore = create<AppearanceStore>((set, get) => {
  const update = (patch: Partial<Appearance>) => {
    set(patch)
    const { theme, text, wide } = get()
    apply({ theme, text, wide })
    try {
      localStorage.setItem(KEY, JSON.stringify({ theme, text, wide }))
    } catch {
      // storage unavailable: the choice lasts for this page only
    }
  }
  const initial = loadAppearance()
  apply(initial)
  return {
    ...initial,
    setTheme: (theme) => update({ theme }),
    setText: (text) => update({ text }),
    setWide: (wide) => update({ wide }),
  }
})

// isDark says whether the page is on the dark sheet: the owner's choice, or
// the system's when they left it to the system.
export function isDark(): boolean {
  const theme = useAppearanceStore.getState().theme
  if (theme !== 'system') return theme === 'dark'
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches
}

export function resetAppearance() {
  const initial = loadAppearance()
  useAppearanceStore.setState(initial)
  apply(initial)
}
