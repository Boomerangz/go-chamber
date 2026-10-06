import type { Folder, Session } from './api'
import { startFolder } from './sessions'

export interface Crumb {
  label: string
  path: string
}

// crumbs splits a folder path into clickable steps, starting at "~" when
// the path is inside home.
export function crumbs(path: string, home: string): Crumb[] {
  const inHome = home !== '' && (path === home || path.startsWith(`${home}/`))
  const out: Crumb[] = [inHome ? { label: '~', path: home } : { label: '/', path: '/' }]
  let current = inHome ? home : ''
  const rest = inHome ? path.slice(home.length) : path
  for (const part of rest.split('/').filter(Boolean)) {
    current = `${current}/${part}`
    out.push({ label: part, path: current })
  }
  return out
}

export function isPathInput(query: string): boolean {
  return query.startsWith('/') || query === '~' || query.startsWith('~/')
}

// filterFolders keeps folders whose name contains the query, prefix
// matches first. A path typed into the filter doesn't filter.
export function filterFolders(folders: Folder[], query: string): Folder[] {
  const q = query.trim().toLowerCase()
  if (!q || isPathInput(q)) return folders
  const matches = folders.filter((f) => f.name.toLowerCase().includes(q))
  const prefix = matches.filter((f) => f.name.toLowerCase().startsWith(q))
  return [...prefix, ...matches.filter((f) => !prefix.includes(f))]
}

// recentFolders lists the working folders of top-level sessions, newest
// session first, without repeats; a worktree session counts as its repository.
export function recentFolders(sessions: Session[], limit: number): string[] {
  const out: string[] = []
  const folder = startFolder(sessions)
  for (let i = sessions.length - 1; i >= 0 && out.length < limit; i--) {
    const s = sessions[i]
    // A worktree is offered as its repository: a worktree of a worktree isn't wanted.
    const cwd = folder(s)
    if (!s.parentId && !out.includes(cwd)) out.push(cwd)
  }
  return out
}
