import { createContext } from 'react'

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
const markdown = new Set(['md', 'markdown'])
const langs: Record<string, string> = {
  go: 'go', ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', py: 'python', php: 'php',
  rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift', c: 'c', h: 'c', cpp: 'cpp', rb: 'ruby', sh: 'bash',
  bash: 'bash', zsh: 'bash', lua: 'lua', proto: 'proto', css: 'css', json: 'json', yaml: 'yaml', yml: 'yaml',
  toml: 'toml', ini: 'ini', xml: 'xml', sql: 'sql', diff: 'diff', patch: 'diff',
}
const plain = new Set(['txt', 'log', 'csv', 'mod', 'tl'])

const extOf = (path: string) => /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? ''

export function fileKind(path: string): FileKind {
  const ext = extOf(path)
  if (images.has(ext)) return 'image'
  if (markdown.has(ext)) return 'markdown'
  if (plain.has(ext) || ext in langs) return 'text'
  return 'download'
}

export function langOf(path: string): string | undefined {
  return langs[extOf(path)]
}

export function fileUrl(sessionId: string, path: string, download = false): string {
  const q = new URLSearchParams({ path })
  if (download) q.set('download', '1')
  return `/api/sessions/${encodeURIComponent(sessionId)}/file?${q}`
}

// SessionFiles carries the session whose folder file links resolve against.
export const SessionFiles = createContext<string | undefined>(undefined)

// MarkLine is the line the file viewer scrolls to and marks.
export const MarkLine = createContext<number | undefined>(undefined)
