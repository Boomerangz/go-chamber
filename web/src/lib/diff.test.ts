import { describe, expect, it } from 'vitest'
import { parseDiff, totals } from './diff'

describe('parseDiff', () => {
  it('numbers old and new lines from each hunk header', () => {
    const lines = parseDiff(
      [
        'diff --git a/a.go b/a.go',
        'index 1..2 100644',
        '--- a/a.go',
        '+++ b/a.go',
        '@@ -10,3 +10,4 @@ func main() {',
        ' keep',
        '-old',
        '+new',
        '+more',
        ' tail',
        '\\ No newline at end of file',
        '@@ -40 +41,0 @@',
        '-gone',
      ].join('\n') + '\n',
    )
    expect(lines.map((l) => [l.kind, l.old ?? null, l.new ?? null, l.sign, l.text])).toEqual([
      ['meta', null, null, '', 'diff --git a/a.go b/a.go'],
      ['meta', null, null, '', 'index 1..2 100644'],
      ['meta', null, null, '', '--- a/a.go'],
      ['meta', null, null, '', '+++ b/a.go'],
      ['hunk', null, null, '', '@@ -10,3 +10,4 @@ func main() {'],
      ['ctx', 10, 10, ' ', 'keep'],
      ['del', 11, null, '-', 'old'],
      ['add', null, 11, '+', 'new'],
      ['add', null, 12, '+', 'more'],
      ['ctx', 12, 13, ' ', 'tail'],
      ['meta', null, null, '', '\\ No newline at end of file'],
      ['hunk', null, null, '', '@@ -40 +41,0 @@'],
      ['del', 40, null, '-', 'gone'],
    ])
  })

  it('reads a diff without headers and an empty one', () => {
    expect(parseDiff('')).toEqual([])
    expect(parseDiff('+x').map((l) => l.kind)).toEqual(['add'])
  })

  it('treats lines before the first hunk as meta even when they start with + or -', () => {
    expect(parseDiff('--- /dev/null\n+++ b/n\n@@ -0,0 +1 @@\n+n\n').map((l) => l.kind)).toEqual(['meta', 'meta', 'hunk', 'add'])
  })
})

describe('totals', () => {
  it('sums counts across files', () => {
    expect(totals([{ added: 3, removed: 1 }, { added: 2, removed: 0 }, {}])).toEqual({ added: 5, removed: 1 })
  })
})
