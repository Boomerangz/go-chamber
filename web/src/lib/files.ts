import { createContext } from 'react'
import { requestRaw } from './api'

// Files agents mention: links like [plan](/Users/me/proj/plan.md) or
// [app.go:42](src/app.go#L42) open through the server, which only serves
// files inside the session folder.

export type FileKind = 'image' | 'markdown' | 'text' | 'download'

// filePath returns the file a link points at, or null for web links.
export function filePath(href: string | undefined): string | null {
  if (!href) return null
  let p = href
  if (p.startsWith('file://')) {
    try {
      p = new URL(p).pathname
    } catch {
      return null
    }
  } else if (p.startsWith('//') || p.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(p)) {
    return null
  }
  p = p.replace(/#.*$/, '').replace(/(:\d+){1,2}$/, '')
  try {
    return decodeURIComponent(p) || null
  } catch {
    return null
  }
}

// fileLine returns the line a file link points at (#L42 or :42), if any.
export function fileLine(href: string | undefined): number | undefined {
  if (filePath(href) === null) return undefined
  const m = /#L(\d+)(?:-L?\d+)?$/.exec(href!) ?? /:(\d+)(?::\d+)?$/.exec(href!.replace(/#.*$/, ''))
  const line = m ? Number(m[1]) : 0
  return line > 0 ? line : undefined
}

const images = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])
const markdown = new Set(['md', 'markdown', 'mdx'])
const langs: Record<string, string> = {
  go: 'go', ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript', mts: 'typescript',
  cts: 'typescript', py: 'python', php: 'php', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift', c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', hpp: 'cpp', rb: 'ruby', sh: 'bash', bash: 'bash', zsh: 'bash', lua: 'lua', proto: 'proto',
  css: 'css', scss: 'css', sass: 'css', less: 'css', json: 'json', jsonc: 'jsonc', json5: 'jsonc', yaml: 'yaml',
  yml: 'yaml', toml: 'toml', ini: 'ini', cfg: 'ini', conf: 'ini', xml: 'xml', sql: 'sql', diff: 'diff', patch: 'diff',
  html: 'html', htm: 'html', vue: 'html', svelte: 'html', graphql: 'graphql', gql: 'graphql', mk: 'makefile',
  dockerfile: 'dockerfile',
}
// Files known by their whole name rather than an extension.
const names: Record<string, string | null> = {
  makefile: 'makefile', gnumakefile: 'makefile', dockerfile: 'dockerfile', containerfile: 'dockerfile',
  '.gitignore': null, '.dockerignore': null, '.gitattributes': null, '.editorconfig': 'ini', '.npmrc': 'ini',
  license: null, readme: null, procfile: null, gemfile: 'ruby', rakefile: 'ruby', 'go.sum': null,
}
// Extensions that are never worth reading as text.
const binary = new Set([
  'svg', 'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar', 'tar', 'jar', 'war', 'class', 'exe', 'dll', 'so',
  'dylib', 'o', 'a', 'wasm', 'bin', 'dmg', 'iso', 'img', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'ico', 'icns', 'bmp',
  'tif', 'tiff', 'psd', 'heic', 'avif', 'mp3', 'mp4', 'm4a', 'mov', 'avi', 'mkv', 'webm', 'wav', 'flac', 'ogg',
  'sqlite', 'db', 'pyc', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'key', 'numbers', 'pages',
])

const nameOf = (path: string) => (path.split('/').pop() ?? '').toLowerCase()
const extOf = (path: string) => /\.([^./]+)$/.exec(nameOf(path))?.[1] ?? ''
const envFile = (name: string) => name === '.env' || name.startsWith('.env.')

// fileKind picks how the viewer shows a file. Anything not known to be
// binary is previewed as text; the viewer still checks the content.
export function fileKind(path: string): FileKind {
  const ext = extOf(path)
  if (images.has(ext)) return 'image'
  if (markdown.has(ext)) return 'markdown'
  if (binary.has(ext)) return 'download'
  return 'text'
}

export function langOf(path: string): string | undefined {
  const name = nameOf(path)
  if (name in names) return names[name] ?? undefined
  if (envFile(name)) return undefined
  return langs[extOf(path)]
}

// looksBinary is git's test: a NUL byte in the first 8000 bytes.
export function looksBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, 8000).includes(0)
}

// PREVIEW_LIMIT is how much of a file the viewer reads; the rest is a
// download away, so a huge log can't freeze the page.
export const PREVIEW_LIMIT = 512 * 1024

export type FetchedFile = { text: string; truncated: boolean; size: number } | { binary: true }

// fetchFile reads up to PREVIEW_LIMIT bytes of a session file as text. A
// refusal is thrown as a sentence; a 401 signs out as every API call does.
export async function fetchFile(sessionId: string, path: string): Promise<FetchedFile> {
  let res: Response
  try {
    res = await requestRaw(fileUrl(sessionId, path))
  } catch {
    throw new Error("Couldn't load the file")
  }
  if (res.status === 403) throw new Error('This file is outside the session folder')
  if (res.status === 404) throw new Error('File not found')
  if (!res.ok) throw new Error((await res.text().catch(() => '')).trim() || `Error ${res.status}`)
  const length = Number(res.headers.get('Content-Length'))
  const head = await readHead(res, PREVIEW_LIMIT)
  if (looksBinary(head.bytes)) return { binary: true }
  const size = Number.isFinite(length) && length > 0 ? length : head.size
  const text = new TextDecoder().decode(head.bytes.subarray(0, PREVIEW_LIMIT))
  return { text, truncated: head.size > PREVIEW_LIMIT || size > PREVIEW_LIMIT, size }
}

// readHead reads at most limit bytes (plus the chunk that crossed it) and
// stops the download there.
async function readHead(res: Response, limit: number): Promise<{ bytes: Uint8Array; size: number }> {
  const reader = res.body?.getReader()
  if (!reader) {
    const all = new Uint8Array(await res.arrayBuffer())
    return { bytes: all, size: all.byteLength }
  }
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.byteLength
    if (size > limit) {
      void reader.cancel().catch(() => {})
      break
    }
  }
  const bytes = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    bytes.set(c, at)
    at += c.byteLength
  }
  return { bytes, size }
}

export function fileUrl(sessionId: string, path: string, download = false): string {
  const q = new URLSearchParams({ path })
  if (download) q.set('download', '1')
  return `/api/sessions/${encodeURIComponent(sessionId)}/file?${q}`
}

// SessionFiles carries the session whose folder file links resolve against.
export const SessionFiles = createContext<string | undefined>(undefined)

// SessionFolder is the session's working folder: paths inside it are written
// from it in the transcript.
export const SessionFolder = createContext<string | undefined>(undefined)

// MarkLine is the line the file viewer scrolls to and marks.
export const MarkLine = createContext<number | undefined>(undefined)
