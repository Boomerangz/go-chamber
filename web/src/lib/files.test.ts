import { describe, expect, it } from 'vitest'
import { fileKind, filePath, fileUrl, langOf } from './files'

describe('files', () => {
  it('finds file paths in links and leaves web links alone', () => {
    expect(filePath('/Users/me/proj/notes.md')).toBe('/Users/me/proj/notes.md')
    expect(filePath('file:///Users/me/a%20b.png')).toBe('/Users/me/a b.png')
    expect(filePath('docs/plan.md#L12')).toBe('docs/plan.md')
    expect(filePath('src/app.go:42')).toBe('src/app.go')
    expect(filePath('src/app.go:42:7')).toBe('src/app.go')
    expect(filePath('./out.png')).toBe('./out.png')
    for (const href of ['https://x.dev/a.md', 'mailto:a@b', '#top', '//cdn/x.js', '', undefined, 'javascript:alert(1)']) {
      expect(filePath(href)).toBeNull()
    }
  })

  it('picks how to show a file', () => {
    expect(fileKind('a/B.PNG')).toBe('image')
    expect(fileKind('x.webp')).toBe('image')
    expect(fileKind('README.md')).toBe('markdown')
    expect(fileKind('notes.txt')).toBe('text')
    expect(fileKind('main.go')).toBe('text')
    expect(fileKind('page.html')).toBe('download')
    expect(fileKind('icon.svg')).toBe('download')
    expect(fileKind('report.pdf')).toBe('download')
    expect(fileKind('Makefile')).toBe('download')
  })

  it('knows the language of code files', () => {
    expect(langOf('main.go')).toBe('go')
    expect(langOf('x.tsx')).toBe('tsx')
    expect(langOf('notes.txt')).toBeUndefined()
  })

  it('builds the file url', () => {
    expect(fileUrl('s 1', '/a b/c.md')).toBe('/api/sessions/s%201/file?path=%2Fa+b%2Fc.md')
    expect(fileUrl('s1', 'x.bin', true)).toBe('/api/sessions/s1/file?path=x.bin&download=1')
  })
})
