// Folder paths for people: the home folder reads as "~", and a path too long
// for its place loses its start, never its last folder (the project name).

function tilde(path: string, home: string | undefined): string {
  const p = path.length > 1 ? path.replace(/\/+$/, '') : path
  const h = home && home.length > 1 ? home.replace(/\/+$/, '') : ''
  if (h && (p === h || p.startsWith(`${h}/`))) return `~${p.slice(h.length)}`
  return p
}

// shortPath writes path with home as "~" and, past max characters, cuts it
// from the start to "…/" plus the folders that fit; the last folder always
// stays whole.
export function shortPath(path: string, home?: string, max = Infinity): string {
  const p = tilde(path, home)
  if (p.length <= max) return p
  const parts = p.split('/')
  let out = parts.pop()!
  while (parts.length > 0 && `…/${parts[parts.length - 1]}/${out}`.length <= max) out = `${parts.pop()}/${out}`
  return `…/${out}`
}

// relativePath writes a path inside folder (the session's) from that folder:
// "src/a.go" rather than a long absolute path whose start says nothing. A
// path elsewhere stays as it is.
export function relativePath(path: string, folder: string | undefined): string {
  const f = folder && folder.length > 1 ? folder.replace(/\/+$/, '') : ''
  if (!f) return path
  if (path === f) return '.'
  return path.startsWith(`${f}/`) ? path.slice(f.length + 1) : path
}

// pathParts splits a path (home as "~") into the folders above and the last
// folder, so a layout can shorten the first and keep the second.
export function pathParts(path: string, home?: string): { head: string; tail: string } {
  const p = tilde(path, home)
  const cut = p.lastIndexOf('/')
  if (cut < 0 || p === '/') return { head: '', tail: p }
  return { head: p.slice(0, cut + 1), tail: p.slice(cut + 1) }
}
