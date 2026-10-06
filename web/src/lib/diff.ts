// Diffs as go-chamber shows them: a unified diff from git or the agent
// (Codex file changes), read line by line with the old and new line numbers
// each hunk header gives, or one made here from an edit's old and new text
// (Claude's Edit, MultiEdit and Write inputs).

export type DiffKind = 'add' | 'del' | 'ctx' | 'hunk' | 'meta'

// DiffLine is one line of a diff; text has no +/- sign, which the view
// draws in its own gutter (see SIGNS). old and new are line numbers, known
// only for lines read from a hunk.
export interface DiffLine {
  kind: DiffKind
  text: string
  old?: number
  new?: number
}

// SIGNS is the diff's own first column for each kind of line.
export const SIGNS: Record<DiffKind, string> = { add: '+', del: '-', ctx: ' ', hunk: '', meta: '' }

export interface DiffStat {
  added: number
  removed: number
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

// parseDiff reads a unified diff; + and - lines before the first hunk are
// file headers.
export function parseDiff(diff: string): DiffLine[] {
  if (!diff) return []
  const out: DiffLine[] = []
  let oldNo = 0
  let newNo = 0
  let inHunk = !diff.startsWith('diff ') && !diff.startsWith('--- ')
  for (const line of diff.replace(/\n$/, '').split('\n')) {
    const hunk = HUNK.exec(line)
    if (hunk) {
      oldNo = Number(hunk[1])
      newNo = Number(hunk[2])
      inHunk = true
      out.push({ kind: 'hunk', text: line })
    } else if (!inHunk || line.startsWith('\\') || line.startsWith('diff ')) {
      if (line.startsWith('diff ')) inHunk = false
      out.push({ kind: 'meta', text: line })
    } else if (line.startsWith('+')) {
      out.push({ kind: 'add', text: line.slice(1), new: newNo++ })
    } else if (line.startsWith('-')) {
      out.push({ kind: 'del', text: line.slice(1), old: oldNo++ })
    } else {
      out.push({ kind: 'ctx', text: line.slice(1), old: oldNo++, new: newNo++ })
    }
  }
  return out
}

// parseUnified reads an agent's diff. Text without a hunk header is not a
// diff (Codex sends a new file's content as is) and stays plain context.
export function parseUnified(diff: string): DiffLine[] {
  const lines = diff.replace(/\n$/, '').split('\n')
  const first = lines.findIndex((line) => line.startsWith('@@'))
  if (first < 0) return lines.map((text) => ({ kind: 'ctx', text }))
  // Everything before the first hunk is a header, whatever it starts with.
  const head = lines.slice(0, first).map((text): DiffLine => ({ kind: 'meta', text }))
  return [...head, ...parseDiff(lines.slice(first).join('\n'))]
}

// totals adds up the line counts of a list of files.
export function totals(files: { added?: number; removed?: number }[]): DiffStat {
  let added = 0
  let removed = 0
  for (const f of files) {
    added += f.added ?? 0
    removed += f.removed ?? 0
  }
  return { added, removed }
}

export function diffStat(lines: DiffLine[]): DiffStat {
  let added = 0
  let removed = 0
  for (const line of lines) {
    if (line.kind === 'add') added++
    else if (line.kind === 'del') removed++
  }
  return { added, removed }
}

// diffText writes lines back as unified-diff text, for copying.
export function diffText(lines: DiffLine[]): string {
  return lines.map((line) => SIGNS[line.kind] + line.text).join('\n')
}

// formatStat prints a stat the way a diff summary reads: "+12 −3".
export function formatStat({ added, removed }: DiffStat): string {
  return `+${added} −${removed}`
}

// Past this many line pairs the diff gives up on matching lines and shows
// the old text removed and the new text added.
const MAX_CELLS = 250_000

const split = (text: string): string[] => (text === '' ? [] : text.replace(/\n$/, '').split('\n'))

// lineDiff compares two texts line by line (longest common subsequence) and
// keeps every line: an edit's snippets are short and read best whole.
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = split(before)
  const b = split(after)
  if (a.length * b.length > MAX_CELLS) {
    return [...a.map((text): DiffLine => ({ kind: 'del', text })), ...b.map((text): DiffLine => ({ kind: 'add', text }))]
  }
  // common[i][j] is the LCS length of a[i:] and b[j:].
  const common = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      common[i]![j] = a[i] === b[j] ? common[i + 1]![j + 1]! + 1 : Math.max(common[i + 1]![j]!, common[i]![j + 1]!)
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'ctx', text: a[i]! })
      i++
      j++
    } else if (common[i + 1]![j]! >= common[i]![j + 1]!) {
      out.push({ kind: 'del', text: a[i++]! })
    } else {
      out.push({ kind: 'add', text: b[j++]! })
    }
  }
  while (i < a.length) out.push({ kind: 'del', text: a[i++]! })
  while (j < b.length) out.push({ kind: 'add', text: b[j++]! })
  return out
}

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

// editDiff turns a file-editing tool's input into a diff: Edit's
// old_string → new_string, MultiEdit's edits one after another, Write's and
// NotebookEdit's new content. Anything else is not an edit.
export function editDiff(input: unknown): DiffLine[] | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const fields = input as Record<string, unknown>
  const oldText = str(fields.old_string)
  const newText = str(fields.new_string)
  if (oldText !== undefined && newText !== undefined) return lineDiff(oldText, newText)
  if (Array.isArray(fields.edits)) {
    const edits = fields.edits.filter(
      (e): e is { old_string: string; new_string: string } =>
        !!e && typeof e === 'object' && str((e as Record<string, unknown>).old_string) !== undefined &&
        str((e as Record<string, unknown>).new_string) !== undefined,
    )
    if (edits.length === 0) return null
    return edits.flatMap((e, n) => [
      { kind: 'hunk' as const, text: `@@ edit ${n + 1} of ${edits.length} @@` },
      ...lineDiff(e.old_string, e.new_string),
    ])
  }
  const content = str(fields.content) ?? str(fields.new_source)
  if (content !== undefined) return lineDiff('', content)
  return null
}
