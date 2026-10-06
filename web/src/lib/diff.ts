// Diffs as the transcript shows them: a unified diff from the agent (Codex
// file changes) or one made here from an edit's old and new text (Claude's
// Edit, MultiEdit and Write inputs).

export type DiffKind = 'add' | 'del' | 'ctx' | 'hunk' | 'meta'

// DiffLine is one line of a diff; text has no +/- sign, which the view
// draws in its own gutter.
export interface DiffLine {
  kind: DiffKind
  text: string
}

export interface DiffStat {
  added: number
  removed: number
}

const META = /^(diff |index |--- |\+\+\+ |new file|deleted file|similarity |rename |old mode|new mode|\\ )/

// parseUnified reads a unified diff. Text without a hunk header is not a
// diff (Codex sends a new file's content as is) and stays plain context.
export function parseUnified(diff: string): DiffLine[] {
  const lines = diff.replace(/\n$/, '').split('\n')
  if (!lines.some((line) => line.startsWith('@@'))) return lines.map((text) => ({ kind: 'ctx', text }))
  return lines.map((line): DiffLine => {
    if (line.startsWith('@@')) return { kind: 'hunk', text: line }
    if (META.test(line)) return { kind: 'meta', text: line }
    if (line.startsWith('+')) return { kind: 'add', text: line.slice(1) }
    if (line.startsWith('-')) return { kind: 'del', text: line.slice(1) }
    return { kind: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line }
  })
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

const signs: Record<DiffKind, string> = { add: '+', del: '-', ctx: ' ', hunk: '', meta: '' }

// diffText writes lines back as unified-diff text, for copying.
export function diffText(lines: DiffLine[]): string {
  return lines.map((line) => signs[line.kind] + line.text).join('\n')
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
