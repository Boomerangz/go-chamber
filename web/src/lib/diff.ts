// A unified diff read line by line, with the old and new line numbers
// each hunk header gives.

export type DiffKind = 'meta' | 'hunk' | 'add' | 'del' | 'ctx'

export interface DiffLine {
  kind: DiffKind
  // sign is the diff's own first column (+, - or a space); empty for
  // headers, which keep their whole text.
  sign: string
  text: string
  old?: number
  new?: number
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

export function parseDiff(diff: string): DiffLine[] {
  if (!diff) return []
  const out: DiffLine[] = []
  let oldNo = 0
  let newNo = 0
  // inHunk: + and - lines before the first hunk are file headers.
  let inHunk = !diff.startsWith('diff ') && !diff.startsWith('--- ')
  for (const line of diff.replace(/\n$/, '').split('\n')) {
    const hunk = HUNK.exec(line)
    if (hunk) {
      oldNo = Number(hunk[1])
      newNo = Number(hunk[2])
      inHunk = true
      out.push({ kind: 'hunk', sign: '', text: line })
    } else if (!inHunk || line.startsWith('\\') || line.startsWith('diff ')) {
      if (line.startsWith('diff ')) inHunk = false
      out.push({ kind: 'meta', sign: '', text: line })
    } else if (line.startsWith('+')) {
      out.push({ kind: 'add', sign: '+', text: line.slice(1), new: newNo++ })
    } else if (line.startsWith('-')) {
      out.push({ kind: 'del', sign: '-', text: line.slice(1), old: oldNo++ })
    } else {
      out.push({ kind: 'ctx', sign: ' ', text: line.slice(1), old: oldNo++, new: newNo++ })
    }
  }
  return out
}

export interface Counts {
  added: number
  removed: number
}

// totals adds up the line counts of a list of files.
export function totals(files: { added?: number; removed?: number }[]): Counts {
  let added = 0
  let removed = 0
  for (const f of files) {
    added += f.added ?? 0
    removed += f.removed ?? 0
  }
  return { added, removed }
}
