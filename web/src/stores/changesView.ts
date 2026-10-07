// ChangesView is how the owner left a session's Changes panel: the files
// they had open and how far down they had scrolled.
export interface ChangesView {
  open: string[]
  scroll: number
}

// Views live as long as the page, like the transcript's reading place: the
// panel unmounting (a dock tab, Overview, another session) keeps them; a
// reload starts every session closed, at the top.
const views = new Map<string, ChangesView>()

export function changesViewOf(sessionId: string): ChangesView {
  return views.get(sessionId) ?? { open: [], scroll: 0 }
}

export function keepOpenFiles(sessionId: string, open: string[]): void {
  views.set(sessionId, { ...changesViewOf(sessionId), open })
}

export function keepChangesScroll(sessionId: string, scroll: number): void {
  views.set(sessionId, { ...changesViewOf(sessionId), scroll })
}

export function resetChangesViews(): void {
  views.clear()
}
