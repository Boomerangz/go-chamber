import { create } from 'zustand'

// Overlay is the keyboard sheet open over the app: the switcher, the
// shortcut list or the settings.
export type Overlay = 'switcher' | 'help' | 'settings' | null

export const useOverlay = create<{ overlay: Overlay }>(() => ({ overlay: null }))

// openShortcuts shows the shortcut list, as ? does.
export function openShortcuts(): void {
  useOverlay.setState({ overlay: 'help' })
}

// openSettings shows the settings, as a comma does.
export function openSettings(): void {
  useOverlay.setState({ overlay: 'settings' })
}
