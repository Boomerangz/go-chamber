import { create } from 'zustand'

// Overlay is the keyboard sheet open over the app: the switcher or the
// shortcut list.
export type Overlay = 'switcher' | 'help' | null

export const useOverlay = create<{ overlay: Overlay }>(() => ({ overlay: null }))

// openShortcuts shows the shortcut list, as ? does.
export function openShortcuts(): void {
  useOverlay.setState({ overlay: 'help' })
}
