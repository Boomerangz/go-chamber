import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchFile, fileKind, fileLine, filePath, fileUrl, langOf, looksBinary, PREVIEW_LIMIT } from './files'

afterEach(() => vi.unstubAllGlobals())

describe('fetchFile', () => {
  it('reads a small text file whole', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('hello')))
    expect(await fetchFile('s1', 'a.txt')).toEqual({ text: 'hello', truncated: false, size: 5 })
  })

  it('keeps only the head of a large file', async () => {
    const big = 'x'.repeat(PREVIEW_LIMIT + 10)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(big, { headers: { 'Content-Length': String(big.length) } })))
    const got = await fetchFile('s1', 'big.log')
    expect(got).toMatchObject({ truncated: true, size: big.length })
    expect('text' in got && got.text.length).toBe(PREVIEW_LIMIT)
  })

  it('says a file is binary instead of showing it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([0x7f, 0x45, 0, 0]))))
    expect(await fetchFile('s1', 'tool')).toEqual({ binary: true })
  })

  it('explains refusals', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 403 })))
    await expect(fetchFile('s1', '/etc/x')).rejects.toThrow('This file is outside the session folder')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
    await expect(fetchFile('s1', 'gone')).rejects.toThrow('File not found')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('disk on fire', { status: 500 })))
    await expect(fetchFile('s1', 'x')).rejects.toThrow('disk on fire')
  })

  it('reports a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline') }))
    await expect(fetchFile('s1', 'x')).rejects.toThrow('Could not load the file')
  })
})

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

  it('keeps the line a link points at', () => {
    expect(fileLine('docs/plan.md#L12')).toBe(12)
    expect(fileLine('docs/plan.md#L12-L20')).toBe(12)
    expect(fileLine('src/app.go:42')).toBe(42)
    expect(fileLine('src/app.go:42:7')).toBe(42)
    expect(fileLine('file:///src/app.go#L3')).toBe(3)
    for (const href of ['src/app.go', 'docs/plan.md#intro', 'src/app.go#L0', 'https://x.dev/a.go#L3', undefined]) {
      expect(fileLine(href)).toBeUndefined()
    }
  })

  it('rejects malformed encoded paths without throwing', () => {
    expect(filePath('docs/%E0%A4.pdf')).toBeNull()
  })

  it('picks how to show a file', () => {
    expect(fileKind('a/B.PNG')).toBe('image')
    expect(fileKind('x.webp')).toBe('image')
    expect(fileKind('README.md')).toBe('markdown')
    expect(fileKind('notes.txt')).toBe('text')
    expect(fileKind('main.go')).toBe('text')
    expect(fileKind('icon.svg')).toBe('download')
    expect(fileKind('report.pdf')).toBe('download')
    expect(fileKind('dist/app.tar.gz')).toBe('download')
    expect(fileKind('docs/intro.mdx')).toBe('markdown')
  })

  it('previews config files and web sources instead of downloading them', () => {
    for (const path of ['Makefile', 'src/Dockerfile', '.gitignore', '.env.example', 'page.html', 'a.scss', 'App.vue', 'schema.graphql', 'tsconfig.jsonc', 'LICENSE', 'go.sum']) {
      expect(fileKind(path), path).toBe('text')
    }
  })

  it('previews an unknown extension as text; the viewer checks for binary content', () => {
    expect(fileKind('notes.weird')).toBe('text')
    expect(fileKind('bin/tool')).toBe('text')
  })

  it('knows the language of code files', () => {
    expect(langOf('main.go')).toBe('go')
    expect(langOf('x.tsx')).toBe('tsx')
    expect(langOf('notes.txt')).toBeUndefined()
    expect(langOf('build/Makefile')).toBe('makefile')
    expect(langOf('Dockerfile')).toBe('dockerfile')
    expect(langOf('index.html')).toBe('html')
    expect(langOf('a.scss')).toBe('css')
    expect(langOf('App.vue')).toBe('html')
    expect(langOf('q.gql')).toBe('graphql')
    expect(langOf('tsconfig.jsonc')).toBe('jsonc')
  })

  it('spots binary content by a NUL byte near the start', () => {
    expect(looksBinary(new Uint8Array([104, 105, 0, 1]))).toBe(true)
    expect(looksBinary(new TextEncoder().encode('plain текст'))).toBe(false)
  })

  it('builds the file url', () => {
    expect(fileUrl('s 1', '/a b/c.md')).toBe('/api/sessions/s%201/file?path=%2Fa+b%2Fc.md')
    expect(fileUrl('s1', 'x.bin', true)).toBe('/api/sessions/s1/file?path=x.bin&download=1')
  })
})
