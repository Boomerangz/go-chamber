import type { AgentKind, Session } from './api'
import { basename } from './format'
import { folderNames, goneFolders, sessionTitle, shelvedIds, startFolder } from './sessions'
import type { Terminal } from './terminal'

export interface SwitcherEntry {
  // new is a session the switcher can start in a known folder.
  kind: 'session' | 'terminal' | 'new'
  id: string
  title: string
  // titleHits and detailHits are the matched character positions.
  titleHits: number[]
  // detail is the folder, in mono.
  detail: string
  detailHits: number[]
  waiting: number
  status: string
  // at is the last activity, for a relative time.
  at?: string
  // current marks the open session.
  current?: boolean
  // archived marks a session put away: found only by a query, and listed
  // below everything else.
  archived?: boolean
  agent?: AgentKind
  cwd?: string
}

export interface Match {
  score: number
  hits: number[]
}

const boundary = (text: string, i: number) => i === 0 || !/[\p{L}\p{N}]/u.test(text[i - 1]!)

// fuzzyMatch finds the word's letters in order in the text, case aside. A
// run of letters beats scattered ones, and a start of a word beats a middle.
export function fuzzyMatch(text: string, word: string): Match | null {
  const hay = text.toLowerCase()
  const needle = word.toLowerCase()
  if (!needle) return { score: 0, hits: [] }
  const at = hay.indexOf(needle)
  if (at >= 0) {
    return { score: 100 + (boundary(hay, at) ? 20 : 0) - Math.min(at, 20), hits: Array.from(needle, (_, i) => at + i) }
  }
  const hits: number[] = []
  let score = 0
  let from = 0
  for (const ch of needle) {
    const i = hay.indexOf(ch, from)
    if (i < 0) return null
    score += 1 + (hits.length > 0 && hits[hits.length - 1] === i - 1 ? 5 : 0) + (boundary(hay, i) ? 3 : 0)
    hits.push(i)
    from = i + 1
  }
  return { score, hits }
}

interface Matched {
  score: number
  titleHits: number[]
  detailHits: number[]
}

// matchAll needs every word in the title or the detail (or, unmarked, the
// full path); the title counts more.
function matchAll(words: string[], title: string, detail: string, path = ''): Matched | null {
  const titleHits = new Set<number>()
  const detailHits = new Set<number>()
  let score = 0
  for (const w of words) {
    const t = fuzzyMatch(title, w)
    const d = fuzzyMatch(detail, w)
    if (t && (!d || t.score * 1.2 >= d.score)) {
      score += t.score * 1.2
      t.hits.forEach((h) => titleHits.add(h))
    } else if (d) {
      score += d.score
      d.hits.forEach((h) => detailHits.add(h))
    } else if (path.toLowerCase().includes(w.toLowerCase())) {
      score += 10
    } else return null
  }
  const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b)
  return { score, titleHits: sorted(titleHits), detailHits: sorted(detailHits) }
}

function rank(e: SwitcherEntry): number {
  if (e.kind === 'new') return 4
  if (e.kind === 'terminal') return 3
  if (e.waiting > 0) return 0
  if (e.status === 'running') return 1
  return 2
}

// section orders the list's parts: what is found, the new sessions, then
// what was archived.
const section = (e: SwitcherEntry) => (e.archived ? 2 : e.kind === 'new' ? 1 : 0)

const agentName: Record<AgentKind, string> = { claude: 'Claude', codex: 'Codex' }

export interface SwitcherOptions {
  activeId?: string | null
}

// switcherEntries is the quick switcher's list: what needs the owner first,
// then what runs, then the most recent; terminals after sessions, then the
// new sessions it can start. A query keeps entries whose title or folder
// holds every word's letters in order, closest matches first, and finds
// archived sessions too, last of all; without one they stay out.
export function switcherEntries(
  sessions: Session[],
  terminals: Terminal[],
  waitingBySession: Map<string, number>,
  query: string,
  { activeId = null }: SwitcherOptions = {},
): SwitcherEntry[] {
  const words = query.split(/\s+/).filter(Boolean)
  const names = folderNames([...sessions.map((s) => s.cwd), ...terminals.map((t) => t.cwd)])
  const name = (cwd: string) => names.get(cwd) ?? basename(cwd)
  const found: { entry: SwitcherEntry; score: number; stamp: string }[] = []
  const add = (base: Omit<SwitcherEntry, 'titleHits' | 'detailHits'>, stamp: string, path?: string) => {
    const m = matchAll(words, base.title, base.detail, path)
    if (m) found.push({ entry: { ...base, titleHits: m.titleHits, detailHits: m.detailHits }, score: m.score, stamp })
  }
  const shelved = shelvedIds(sessions)
  for (const s of sessions) {
    const archived = shelved.has(s.id)
    if (archived && !words.length) continue
    add(
      {
        kind: 'session',
        id: s.id,
        title: sessionTitle(s),
        detail: name(s.cwd),
        waiting: waitingBySession.get(s.id) ?? 0,
        status: s.status,
        at: s.activeAt ?? s.createdAt,
        current: s.id === activeId || undefined,
        archived: archived || undefined,
      },
      s.activeAt ?? s.createdAt ?? '',
      `${s.cwd} ${s.agent}`,
    )
  }
  for (const t of terminals) {
    add({ kind: 'terminal', id: t.id, title: t.title || basename(t.cwd), detail: name(t.cwd), waiting: 0, status: t.status }, '', t.cwd)
  }
  // New sessions: in the open session's folder at rest, in any folder asked
  // for — a worktree's repository, never the worktree (it may be gone).
  const byRecent = [...sessions].filter((s) => !s.parentId && !shelved.has(s.id)).sort((a, b) => (b.activeAt ?? b.createdAt ?? '').localeCompare(a.activeAt ?? a.createdAt ?? ''))
  const start = startFolder(sessions)
  // Never in a folder the server found gone.
  const gone = goneFolders(sessions)
  const open = sessions.find((s) => s.id === activeId) ?? byRecent[0]
  const folders = (words.length ? [...new Set(byRecent.map(start))] : open ? [start(open)] : []).filter((cwd) => !gone.has(cwd))
  const newNames = folderNames(folders)
  for (const cwd of folders) {
    const label = names.get(cwd) ?? newNames.get(cwd) ?? basename(cwd)
    for (const agent of ['claude', 'codex'] as const) {
      add({ kind: 'new', id: `${agent}:${cwd}`, title: `New ${agentName[agent]} session in ${label}`, detail: cwd, waiting: 0, status: 'new', agent, cwd }, '')
    }
  }
  return found
    .sort((a, b) => {
      const byKind = section(a.entry) - section(b.entry)
      if (byKind !== 0) return byKind
      if (words.length && a.score !== b.score) return b.score - a.score
      const byRank = rank(a.entry) - rank(b.entry)
      if (byRank !== 0) return byRank
      return b.stamp.localeCompare(a.stamp)
    })
    .map((f) => f.entry)
}
