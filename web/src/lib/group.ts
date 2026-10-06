import type { Item } from './api'
import { toolLabel } from './toolSummary'
import type { ItemNode } from './tree'

// A run of this many finished tool lines folds into one line that says
// what they did; a run that only read and searched folds from LOOK_MIN.
export const GROUP_MIN = 3
const LOOK_MIN = 2

// Tools that edit a file: their diff is what the owner reviews, so they
// keep a line of their own.
const EDITS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

// groupable: a finished tool line with nothing to say on its own. Edits, a
// failed line, a command that exited non-zero and anything still running
// stay out.
function groupable(node: ItemNode): boolean {
  const item = node.item
  if (item.kind !== 'tool_call' && item.kind !== 'command') return false
  if (item.name && EDITS.has(item.name)) return false
  if (item.status !== 'completed' || node.children.length > 0) return false
  // A command without an exit code never ran (it was denied).
  return item.kind === 'command' ? item.exitCode === 0 : true
}

// looks: a tool that only reads or searches, so a pair of them says
// nothing worth a line each.
function looks(node: ItemNode): boolean {
  const name = node.item.name ?? ''
  return node.item.kind === 'tool_call' && (READS.has(name) || SEARCHES.has(name))
}

// groupTools folds each run of GROUP_MIN or more consecutive finished tool
// lines of one turn into a group node (keyed by its first item). split names
// an item that must start a row of its own (the "new since you left" mark).
export function groupTools(nodes: ItemNode[], split?: string | null): ItemNode[] {
  const out: ItemNode[] = []
  let run: ItemNode[] = []
  const flush = () => {
    if (run.length >= GROUP_MIN || (run.length >= LOOK_MIN && run.every(looks))) out.push({ item: run[0]!.item, children: [], group: run })
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
  const path = input.file_path ?? input.path ?? input.notebook_path
  return typeof path === 'string' && path ? path : item.id
}

// category sorts a tool line into what it did: read, searched, ran.
function category(item: Item): Omit<Tally, 'keys' | 'calls'> & { key: string } {
  if (item.kind === 'command') return { key: 'ran', verb: 'ran', one: 'command', many: 'commands', distinct: false }
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
