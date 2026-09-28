import type { AgentKind } from './api'

export interface Command {
  name: string
  description?: string
  argumentHint?: string
  // insert is the text that invokes the command: "/review" or "$skill".
  insert: string
}

export interface FileMatch {
  path: string
  dir?: boolean
}

// Token is the word under the caret that the popup completes; start..end is
// the whole word, query is its text up to the caret without the trigger.
export interface Token {
  kind: 'file' | 'command'
  query: string
  start: number
  end: number
}

// findToken spots "@path" anywhere, "/command" at the start of the message
// and, for Codex, "$skill" anywhere.
export function findToken(text: string, caret: number, agent: AgentKind | undefined): Token | null {
  let start = caret
  while (start > 0 && !/\s/.test(text[start - 1])) start--
  let end = caret
  while (end < text.length && !/\s/.test(text[end])) end++
  const trigger = text[start]
  const query = text.slice(start + 1, caret)
  if (caret === start) return null
  if (trigger === '@') return { kind: 'file', query, start, end }
  if (trigger === '/' && text.slice(0, start).trim() === '') return { kind: 'command', query, start, end }
  if (trigger === '$' && agent === 'codex') return { kind: 'command', query, start, end }
  return null
}

// applyCompletion swaps the token for insert; a folder stays open for more
// typing, anything else is followed by a space.
export function applyCompletion(text: string, token: Token, insert: string, dir: boolean): { text: string; caret: number } {
  const tail = text.slice(token.end)
  const glue = dir || tail.startsWith(' ') ? '' : ' '
  const head = text.slice(0, token.start) + insert + glue
  return { text: head + tail, caret: dir ? head.length : head.length + (tail.startsWith(' ') ? 1 : 0) }
}

export function filterCommands(commands: Command[], query: string): Command[] {
  const q = query.toLowerCase()
  const prefix = commands.filter((c) => c.name.toLowerCase().startsWith(q))
  const inside = commands.filter((c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q))
  return [...prefix, ...inside].slice(0, 50)
}

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin' })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return (await res.json()) as T
}

export function completeFiles(sessionId: string, query: string): Promise<FileMatch[]> {
  return getJSON(`/api/sessions/${encodeURIComponent(sessionId)}/complete/files?q=${encodeURIComponent(query)}`)
}

const commandCache = new Map<string, Promise<Command[]>>()

// listCommands asks once per session; a failed lookup is retried next time.
export function listCommands(sessionId: string): Promise<Command[]> {
  let p = commandCache.get(sessionId)
  if (!p) {
    p = getJSON<Command[]>(`/api/sessions/${encodeURIComponent(sessionId)}/commands`)
    p.catch(() => commandCache.delete(sessionId))
    commandCache.set(sessionId, p)
  }
  return p
}
