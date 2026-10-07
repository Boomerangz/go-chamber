// leaveTerminal is the terminal's way out by the keyboard (⌘↑, Ctrl+Shift+↑
// elsewhere): back to the composer when a chat shows one, else out of the
// terminal altogether, so the single-key shortcuts answer again.
export function leaveTerminal(): void {
  const from = document.activeElement
  const composer = document.querySelector<HTMLElement>('.composer textarea')
  composer?.focus()
  // A composer out of sight (another mode, a closed pane) takes no focus.
  if (document.activeElement === from && from instanceof HTMLElement) from.blur()
}
