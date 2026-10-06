import { describe, expect, it } from 'vitest'
import { diffStat, diffText, editDiff, formatStat, lineDiff, parseUnified, type DiffLine } from './diff'

const kinds = (lines: DiffLine[]) => lines.map((l) => `${l.kind}:${l.text}`)

describe('parseUnified', () => {
  it('reads headers, hunks, additions, removals and context', () => {
    const diff = [
      'diff --git a/x.go b/x.go',
      'index 1..2 100644',
      '--- a/x.go',
      '+++ b/x.go',
      '@@ -1,3 +1,3 @@',
      ' keep',
      '-old',
      '+new',
      '',
      '\\ No newline at end of file',
      '',
    ].join('\n')
    expect(kinds(parseUnified(diff))).toEqual([
      'meta:diff --git a/x.go b/x.go',
      'meta:index 1..2 100644',
      'meta:--- a/x.go',
      'meta:+++ b/x.go',
      'hunk:@@ -1,3 +1,3 @@',
      'ctx:keep',
      'del:old',
      'add:new',
      'ctx:',
      'meta:\\ No newline at end of file',
    ])
  })

  it('reads new-file, rename and mode headers as metadata', () => {
    const diff = ['new file mode 100644', 'deleted file mode 100644', 'similarity index 90%', 'rename from a', 'old mode 1', 'new mode 2', '@@ -0,0 +1 @@', '+x'].join('\n')
    expect(parseUnified(diff).map((l) => l.kind)).toEqual(['meta', 'meta', 'meta', 'meta', 'meta', 'meta', 'hunk', 'add'])
  })

  it('keeps text without a hunk header as plain context', () => {
    expect(kinds(parseUnified('+plus\n-minus\nline\n'))).toEqual(['ctx:+plus', 'ctx:-minus', 'ctx:line'])
  })
})

describe('diffStat / formatStat', () => {
  it('counts added and removed lines, not headers', () => {
    const stat = diffStat(parseUnified('--- a\n+++ b\n@@ -1 +1,2 @@\n-a\n+b\n+c\n ctx'))
    expect(stat).toEqual({ added: 2, removed: 1 })
    expect(formatStat(stat)).toBe('+2 −1')
  })
})

describe('diffText', () => {
  it('writes lines back with their signs', () => {
    const lines: DiffLine[] = [
      { kind: 'meta', text: '--- a' },
      { kind: 'hunk', text: '@@ -1 +1 @@' },
      { kind: 'ctx', text: 'same' },
      { kind: 'del', text: 'old' },
      { kind: 'add', text: 'new' },
    ]
    expect(diffText(lines)).toBe('--- a\n@@ -1 +1 @@\n same\n-old\n+new')
  })
})

describe('lineDiff', () => {
  it('keeps common lines as context and marks the changed ones', () => {
    expect(kinds(lineDiff('a\nb\nc\n', 'a\nB\nc\nd\n'))).toEqual(['ctx:a', 'del:b', 'add:B', 'ctx:c', 'add:d'])
  })

  it('finds the longest run of common lines', () => {
    expect(kinds(lineDiff('x\na\nb', 'a\nb\ny'))).toEqual(['del:x', 'ctx:a', 'ctx:b', 'add:y'])
    expect(kinds(lineDiff('a\nb\nc', 'c\na\nb'))).toEqual(['add:c', 'ctx:a', 'ctx:b', 'del:c'])
  })

  it('removes and adds whole texts', () => {
    expect(kinds(lineDiff('', 'one\ntwo'))).toEqual(['add:one', 'add:two'])
    expect(kinds(lineDiff('one', ''))).toEqual(['del:one'])
    expect(lineDiff('', '')).toEqual([])
  })

  it('gives up matching on huge inputs and shows old then new', () => {
    const big = (c: string) => Array.from({ length: 600 }, (_, i) => `${c}${i}`).join('\n')
    const out = lineDiff(big('a'), big('b'))
    expect(out).toHaveLength(1200)
    expect(out[0]).toEqual({ kind: 'del', text: 'a0' })
    expect(out[599]).toEqual({ kind: 'del', text: 'a599' })
    expect(out[600]).toEqual({ kind: 'add', text: 'b0' })
    expect(out[1199]).toEqual({ kind: 'add', text: 'b599' })
  })

  it('still matches inputs just under the limit', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `l${i}`)
    const out = lineDiff(lines.join('\n'), [...lines.slice(0, 499), 'changed'].join('\n'))
    expect(out.filter((l) => l.kind === 'ctx')).toHaveLength(499)
  })
})

describe('editDiff', () => {
  it('diffs an Edit from old_string to new_string', () => {
    expect(kinds(editDiff({ file_path: '/a', old_string: 'x\ny', new_string: 'x\nz' })!)).toEqual(['ctx:x', 'del:y', 'add:z'])
  })

  it('takes an empty old_string as an insertion', () => {
    expect(kinds(editDiff({ old_string: '', new_string: 'n' })!)).toEqual(['add:n'])
  })

  it('numbers the edits of a MultiEdit', () => {
    const out = editDiff({ edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }, 'junk', null] })!
    expect(kinds(out)).toEqual(['hunk:@@ edit 1 of 2 @@', 'del:a', 'add:b', 'hunk:@@ edit 2 of 2 @@', 'del:c', 'add:d'])
  })

  it('skips a MultiEdit without usable edits', () => {
    expect(editDiff({ edits: [{ old_string: 'a' }] })).toBeNull()
  })

  it('shows written content as added', () => {
    expect(kinds(editDiff({ file_path: '/a', content: 'one\ntwo\n' })!)).toEqual(['add:one', 'add:two'])
    expect(kinds(editDiff({ notebook_path: '/n', new_source: 'print(1)' })!)).toEqual(['add:print(1)'])
  })

  it('is null for anything that is not an edit', () => {
    expect(editDiff(undefined)).toBeNull()
    expect(editDiff('text')).toBeNull()
    expect(editDiff(['a'])).toBeNull()
    expect(editDiff({ file_path: '/a' })).toBeNull()
    expect(editDiff({ old_string: 'a' })).toBeNull()
    expect(editDiff({ old_string: 1, new_string: 2 })).toBeNull()
  })
})
