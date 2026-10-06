import type { Item } from './api'
import { toolLabel } from './toolSummary'
import type { ItemNode } from './tree'

// A run of this many finished tool lines folds into one line that says
// what they did.
export const GROUP_MIN = 3

// groupable: a finished tool line with nothing to say on its own. A failed
// one, a command that exited non-zero and anything still running stay out.
function groupable(node: ItemNode): boolean {
  const item = node.item
  if (item.kind !== 'tool_call' && item.kind !== 'command' && item.kind !== 'file_change') return false
  if (item.status !== 'completed' || node.children.length > 0) return false
  return item.exitCode === undefined || item.exitCode === 0
}

// groupTools folds each run of GROUP_MIN or more consecutive finished tool
// lines of one turn into a group node (keyed by its first item). split names
// an item that must start a row of its own (the "new since you left" mark).
export function groupTools(nodes: ItemNode[], split?: string | null): ItemNode[] {
  const out: ItemNode[] = []
  let run: ItemNode[] = []
  const flush = () => {
    if (run.length >= GROUP_MIN) out.push({ item: run[0]!.item, children: [], group: run })
    else out.push(...run)
    run = []
  }
  for (const node of nodes) {
    if (!groupable(node)) {
      flush()
      out.push(node)
      continue
    }
    if (run.length > 0 && (node.item.id === split || node.item.turnId !== run[0]!.item.turnId)) flush()
    run.push(node)
  }
  flush()
  return out
}

// lastItemId is the id of the last item a row shows.
export function lastItemId(node: ItemNode): string {
  return node.group ? node.group[node.group.length - 1]!.item.id : node.item.id
}

interface Tally {
  verb: string
  one: string
  many: string
  keys: Set<string>
  calls: number
  // distinct counts different targets (files) instead of calls.
  distinct: boolean
}

const READS = new Set(['Read', 'NotebookRead', 'read_file'])
const SEARCHES = new Set(['Grep', 'Glob', 'LS', 'grep', 'glob', 'search'])

function target(item: Item): string {
  const input = item.input && typeof item.input === 'object' ? (item.input as Record<string, unknown>) : {}
  const path = item.path ?? input.file_path ?? input.path ?? input.notebook_path
  return typeof path === 'string' && path ? path : item.id
}

// category sorts a tool line into what it did: read, searched, edited, ran.
function category(item: Item): Omit<Tally, 'keys' | 'calls'> & { key: string } {
  if (item.kind === 'command') return { key: 'ran', verb: 'ran', one: 'command', many: 'commands', distinct: false }
  if (item.kind === 'file_change') return { key: 'edited', verb: 'edited', one: 'file', many: 'files', distinct: true }
  const name = item.name ?? ''
  if (READS.has(name)) return { key: 'read', verb: 'read', one: 'file', many: 'files', distinct: true }
  if (SEARCHES.has(name)) return { key: 'searched', verb: 'searched', one: 'pattern', many: 'patterns', distinct: false }
  if (name === 'WebFetch') return { key: 'fetched', verb: 'fetched', one: 'page', many: 'pages', distinct: false }
  if (name === 'WebSearch' || name === 'webSearch') {
    return { key: 'web', verb: 'ran', one: 'web search', many: 'web searches', distinct: false }
  }
  const label = toolLabel(item.name)
  return { key: `tool:${label}`, verb: label, one: '', many: '', distinct: false }
}

// groupSummary says what a group of tool lines did, in the order it did it:
// "Read 12 files · searched 3 patterns · TodoWrite ×2".
export function groupSummary(nodes: ItemNode[]): string {
  const tallies = new Map<string, Tally>()
  for (const { item } of nodes) {
    const { key, ...rest } = category(item)
    const tally = tallies.get(key) ?? { ...rest, keys: new Set<string>(), calls: 0 }
    tally.calls++
    tally.keys.add(target(item))
    tallies.set(key, tally)
  }
  const parts = [...tallies.values()].map((t) => {
    if (!t.one) return t.calls > 1 ? `${t.verb} ×${t.calls}` : t.verb
    const n = t.distinct ? t.keys.size : t.calls
    return `${t.verb} ${n} ${n === 1 ? t.one : t.many}`
  })
  const text = parts.join(' · ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}
