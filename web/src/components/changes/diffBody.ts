import type { DiffLine } from '../../lib/diff'

export interface DiffBody {
  // lines are the hunks, without git's header lines before the first one.
  lines: DiffLine[]
  // note keeps what the header said that matters: a rename, a mode change.
  note: string | null
  // binary is git's "Binary files … differ" in place of hunks.
  binary: boolean
}

const BINARY = /^Binary files .* differ$|^GIT binary patch$/

// diffBody reads a file's diff as the Changes panel shows it: the header
// git prints (diff --git, index, ---/+++) says nothing the row doesn't.
export function diffBody(lines: DiffLine[]): DiffBody {
  let first = lines.findIndex((l) => l.kind !== 'meta')
  if (first < 0) first = lines.length
  const head = lines.slice(0, first).map((l) => l.text)
  const field = (prefix: string) => head.find((t) => t.startsWith(prefix))?.slice(prefix.length)
  const notes: string[] = []
  const from = field('rename from ')
  if (from) notes.push(`renamed from ${from}`)
  const oldMode = field('old mode ')
  const newMode = field('new mode ')
  if (oldMode && newMode) notes.push(`mode ${oldMode} → ${newMode}`)
  return {
    lines: lines.slice(first),
    note: notes.length ? notes.join(' · ') : null,
    binary: head.some((t) => BINARY.test(t)),
  }
}
