import type { AgentKind, Session } from './api'
import { basename } from './format'
import { sessionTree, type SessionNode } from './tree'

// GroupMode is how much of a project group the sidebar shows.
export type GroupMode = 'collapsed' | 'recent' | 'all'

export interface SessionGroup {
  cwd: string
  name: string
  // nodes are top-level sessions, newest first, with nested children.
  nodes: SessionNode[]
  count: number
  running: boolean
  activeAt: number
}

function stamp(iso: string | undefined): number {
  if (!iso) return 0
  const t = Date.parse(iso)
  return Number.isNaN(t) || new Date(t).getUTCFullYear() < 2000 ? 0 : t
}

const activity = (s: Session) => stamp(s.activeAt) || stamp(s.createdAt)

// shelvedIds are the archived sessions and the subagents below them: they
// leave the list together.
export function shelvedIds(sessions: Session[]): Set<string> {
  const byId = new Map(sessions.map((s) => [s.id, s]))
  const out = new Set<string>()
  for (const s of sessions) {
    // Walk up the parents; the bound guards against a malformed cycle.
    let at: Session | undefined = s
    for (let depth = 0; at && depth < sessions.length; depth++) {
      if (at.archivedAt) {
        out.add(s.id)
        break
      }
      at = at.parentId ? byId.get(at.parentId) : undefined
    }
  }
  return out
}

// archivedSessions are the archived sessions, most recently archived first,
// with their subagents nested.
export function archivedSessions(sessions: Session[]): SessionNode[] {
  const shelved = shelvedIds(sessions)
  return sessionTree(sessions.filter((s) => shelved.has(s.id))).sort((a, b) =>
    (b.session.archivedAt ?? '').localeCompare(a.session.archivedAt ?? ''),
  )
}

// groupSessions groups the listed (not archived) sessions by working
// folder. Groups and sessions are ordered by last activity, newest first;
// subagent sessions stay nested under their parent.
export function groupSessions(sessions: Session[]): SessionGroup[] {
  const shelved = shelvedIds(sessions)
  const byCwd = new Map<string, Session[]>()
  for (const s of sessions) {
    if (shelved.has(s.id)) continue
    const list = byCwd.get(s.cwd) ?? []
    list.push(s)
    byCwd.set(s.cwd, list)
  }
  const groups: SessionGroup[] = []
  for (const [cwd, list] of byCwd) {
    const nodes = sessionTree(list).sort((a, b) => activity(b.session) - activity(a.session))
    groups.push({
      cwd,
      name: basename(cwd),
      nodes,
      count: nodes.length,
      running: list.some((s) => s.status === 'running'),
      activeAt: Math.max(...list.map(activity)),
    })
  }
  return disambiguate(groups).sort((a, b) => b.activeAt - a.activeAt)
}

// disambiguate names groups that share a folder name by their parent too
// ("app/web", "site/web"), so two projects never look the same.
function disambiguate(groups: SessionGroup[]): SessionGroup[] {
  const names = folderNames(groups.map((g) => g.cwd))
  for (const g of groups) g.name = names.get(g.cwd) ?? g.name
  return groups
}

// folderNames gives each folder a short name: its last part, or its last
// two parts when another folder has the same last part.
export function folderNames(cwds: string[]): Map<string, string> {
  const unique = [...new Set(cwds)]
  const count = new Map<string, number>()
  for (const cwd of unique) count.set(basename(cwd), (count.get(basename(cwd)) ?? 0) + 1)
  const names = new Map<string, string>()
  for (const cwd of unique) {
    const parts = cwd.split('/').filter(Boolean)
    const name = basename(cwd)
    names.set(cwd, (count.get(name) ?? 0) >= 2 && parts.length >= 2 ? parts.slice(-2).join('/') : name)
  }
  return names
}

function contains(node: SessionNode, id: string): boolean {
  return node.session.id === id || node.children.some((c) => contains(c, id))
}

// visibleInGroup picks the sessions shown for a group mode. The open
// session always stays visible so the sidebar never hides where you are.
export function visibleInGroup(
  group: SessionGroup,
  mode: GroupMode,
  recent: number,
  activeId: string | null,
): { shown: SessionNode[]; hidden: number } {
  if (mode === 'all') return { shown: group.nodes, hidden: 0 }
  const limit = mode === 'collapsed' ? 0 : recent
  const shown = group.nodes.filter((n, i) => i < limit || (activeId !== null && contains(n, activeId)))
  return { shown, hidden: group.nodes.length - shown.length }
}

export type Bucket = 'Today' | 'Yesterday' | 'This week' | 'This month' | 'Older'

// bucketOf places an activity time into a coarse bucket for dividers.
export function bucketOf(iso: string | undefined, now: Date = new Date()): Bucket {
  const t = stamp(iso)
  if (!t) return 'Older'
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  const start = day.getTime()
  const DAY = 86_400_000
  if (t >= start) return 'Today'
  if (t >= start - DAY) return 'Yesterday'
  if (t >= start - 6 * DAY) return 'This week'
  if (t >= start - 30 * DAY) return 'This month'
  return 'Older'
}

export function relativeTime(iso: string | undefined, now: Date = new Date()): string {
  const t = stamp(iso)
  if (!t) return ''
  const mins = Math.floor((now.getTime() - t) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  const date = new Date(t)
  const sameYear = date.getFullYear() === now.getFullYear()
  return date.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })
}

// matchesQuery is the client-side part of session search: title, folder
// and agent. Content search happens on the server.
export function matchesQuery(session: Session, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [session.title ?? '', session.cwd, session.agent].some((v) => v.toLowerCase().includes(q))
}

const agentName: Record<AgentKind, string> = { claude: 'Claude', codex: 'Codex' }

// sessionTitle is the name shown for a session: its title (the first
// message by default) or a placeholder before anything was sent.
export function sessionTitle(s: Session): string {
  return s.title || `New ${agentName[s.agent]} session`
}

export interface SnippetPart {
  text: string
  match: boolean
}

// snippetParts splits a search snippet into plain and matched text; the
// server marks matches with [[ and ]].
export function snippetParts(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = []
  const re = /\[\[(.*?)\]\]/g
  let last = 0
  for (let m = re.exec(snippet); m; m = re.exec(snippet)) {
    if (m.index > last) parts.push({ text: snippet.slice(last, m.index), match: false })
    parts.push({ text: m[1], match: true })
    last = m.index + m[0].length
  }
  if (last < snippet.length) parts.push({ text: snippet.slice(last), match: false })
  return parts
}
