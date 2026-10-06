import { describe, expect, it } from 'vitest'
import { parseDiff } from '../../lib/diff'
import { diffBody } from './diffBody'

const git = (head: string[], body: string[]) => parseDiff([...head, ...body].join('\n') + '\n')

describe('diffBody', () => {
  it('drops the git header before the first hunk', () => {
    const body = diffBody(git(['diff --git a/x b/x', 'index 1..2 100644', '--- a/x', '+++ b/x'], ['@@ -1 +1 @@', '-a', '+b']))
    expect(body.lines.map((l) => l.text)).toEqual(['@@ -1 +1 @@', 'a', 'b'])
    expect(body.note).toBeNull()
    expect(body.binary).toBe(false)
  })

  it('keeps a rename and a mode change as one quiet note', () => {
    const body = diffBody(git(
      ['diff --git a/old.go b/new.go', 'old mode 100644', 'new mode 100755', 'similarity index 90%', 'rename from old.go', 'rename to new.go', '--- a/old.go', '+++ b/new.go'],
      ['@@ -1 +1 @@', '-a', '+b'],
    ))
    expect(body.note).toBe('renamed from old.go · mode 100644 → 100755')
    expect(body.lines[0]!.kind).toBe('hunk')
  })

  it('knows a binary diff', () => {
    const body = diffBody(git(['diff --git a/p.png b/p.png', 'index 1..2 100644', 'Binary files a/p.png and b/p.png differ'], []))
    expect(body.binary).toBe(true)
    expect(body.lines).toEqual([])
  })

  it('keeps meta lines inside the hunks and a diff without a header', () => {
    const body = diffBody(parseDiff('@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n'))
    expect(body.lines).toHaveLength(4)
    expect(body.binary).toBe(false)
    expect(diffBody(parseDiff('+one\n')).lines).toHaveLength(1)
  })

  it('reads a mode change alone', () => {
    const body = diffBody(git(['diff --git a/x b/x', 'old mode 100644', 'new mode 100755'], []))
    expect(body.note).toBe('mode 100644 → 100755')
    expect(body.lines).toEqual([])
    expect(body.binary).toBe(false)
  })
})
