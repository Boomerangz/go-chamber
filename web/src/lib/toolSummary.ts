import type { Item } from './api'

// The input fields that best say what a tool works on, most telling first.
const KEYS = ['file_path', 'path', 'notebook_path', 'pattern', 'url', 'query', 'command', 'description', 'prompt']
// A fallback field longer than this is content (a body, a patch), not a name.
const SHORT = 200

// toolSummary is the one line shown after a tool's name: the file it reads,
// the pattern it searches for, the command it runs.
export function toolSummary(item: Item): string | undefined {
  const input = item.input
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const fields = input as Record<string, unknown>
  for (const key of KEYS) {
    const value = oneLine(fields[key])
    if (value) return value
  }
  for (const value of Object.values(fields)) {
    const line = oneLine(value)
    if (line && line.length <= SHORT) return line
  }
  return undefined
}

function oneLine(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.replace(/\s+/g, ' ').trim() || undefined
}

// toolLabel prints mcp__server__tool as "server · tool".
export function toolLabel(name: string | undefined): string {
  if (!name) return 'tool'
  const parts = name.split('__')
  if (parts[0] !== 'mcp' || parts.length < 3) return name
  return `${parts[1]} · ${parts.slice(2).join('__')}`
}

// toolInput is the full input for the fold under a tool line.
export function toolInput(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined
  if (typeof input === 'object' && Object.keys(input).length === 0) return undefined
  return JSON.stringify(input, null, 2)
}
