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

// A path in running text: long, with a letter, folders between slashes.
// Numbers ("1290/1300") and dates have no letter and stay whole.
const PATH_LIKE = /\S*[A-Za-z]\S*/g
const PATH_MIN = 12

// pathBreaks cuts text after each slash of a long path in it, so a narrow
// column can break the path between folders (a <wbr> between the pieces)
// rather than take its whole width. Words, numbers and short paths stay as
// they are; with nothing to cut, the text comes back as one piece.
export function pathBreaks(text: string): string[] {
  const pieces: string[] = []
  let from = 0
  for (const m of text.matchAll(PATH_LIKE)) {
    const token = m[0]
    if (token.length < PATH_MIN || !token.includes('/')) continue
    for (let i = token.indexOf('/'); i >= 0 && i < token.length - 1; i = token.indexOf('/', i + 1)) {
      const at = m.index + i + 1
      pieces.push(text.slice(from, at))
      from = at
    }
  }
  pieces.push(text.slice(from))
  return pieces
}

// pathParts splits a path (home as "~") into the folders above and the last
// folder, so a layout can shorten the first and keep the second.
export function pathParts(path: string, home?: string): { head: string; tail: string } {
  const p = tilde(path, home)
  const cut = p.lastIndexOf('/')
  if (cut < 0 || p === '/') return { head: '', tail: p }
  return { head: p.slice(0, cut + 1), tail: p.slice(cut + 1) }
}
