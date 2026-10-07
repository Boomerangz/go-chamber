import { CROWDED, useLayoutStore } from '../../stores/layout'
import { useSessionStore } from '../../stores/session'
import { matches } from '../chat/useMedia'

// Reveal the destination before focusing: a hidden field cannot take focus.
export function focusIn(selector: string, pane?: 'sessions' | 'chat') {
  const layout = useLayoutStore.getState()
  layout.setMode('agents')
  if (pane === 'sessions') {
    if (layout.focus) layout.toggleFocus()
    if (!layout.sidebar) layout.toggleSidebar()
    if (layout.dock && matches(CROWDED)) layout.toggleDock(layout.dock)
  }
  if (pane) useSessionStore.getState().setPane(pane)
  requestAnimationFrame(() => {
    if (selector.includes('.new-session')) {
      // On phones, unfold before attempting to focus the project field.
      document.querySelector<HTMLButtonElement>('.new-session-open[aria-expanded="false"]')?.click()
    }
    requestAnimationFrame(() => document.querySelector<HTMLElement>(selector)?.focus())
  })
}

export function chooseProject() {
  focusIn('.new-session .folder-field input', 'sessions')
}
