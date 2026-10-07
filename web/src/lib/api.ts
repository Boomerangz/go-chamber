export type Health = 'online' | 'offline' | 'unauthorized'

export type AgentKind = 'claude' | 'codex'
export type SessionStatus = 'detached' | 'idle' | 'running' | 'interrupted'

export interface Interruption {
  reason?: string
  resumeAfter?: string
  // withRequest: the turn was cut off while a question or permission waited
  // for the owner, who still owes it an answer.
  withRequest?: boolean
  // request: the gist of the request it was waiting on, when known.
  request?: string
}

// ApprovalReviewer decides who reviews the agent's approval requests (Codex);
// absent means the agent's own configuration decides.
export type ApprovalReviewer = 'user' | 'auto_review'

export interface Session {
  id: string
  agent: AgentKind
  cwd: string
  nativeId?: string
  parentId?: string
  // forkOf is the session this one branched off from.
  forkOf?: string
  status: SessionStatus
  title?: string
  interruption?: Interruption
  // autoContinue resumes a quota-interrupted turn once the limit resets.
  autoContinue?: boolean
  approvalReviewer?: ApprovalReviewer
  // permissionMode is empty when the agent's configuration decides.
  permissionMode?: string
  createdAt?: string
  activeAt?: string
  // model and effort are empty when the agent's configuration decides.
  model?: string
  effort?: string
  // worktree is set when go-chamber created the session folder as a git worktree.
  worktree?: Worktree
  // archivedAt is set while the session is put away from the list.
  archivedAt?: string
  // folderGone is set when the server last found the session's folder
  // missing (a removed worktree says so by itself).
  folderGone?: boolean
  // seen is where the owner last looked, on any device: when, and the last
  // item read then.
  seen?: Seen
  // endedAt is when a turn last ended.
  endedAt?: string
}

export interface Seen {
  item?: string
  at?: string
}

export interface Worktree {
  repo: string
  path: string
  branch: string
  base: string
  // removed is set once the folder is gone; the branch stays in repo.
  removed?: boolean
}

export type ItemKind =
  | 'user_message'
  | 'assistant_message'
  | 'reasoning'
  | 'tool_call'
  | 'command'
  | 'file_change'
  | 'subagent'
  | 'plan'
  | 'error'
  | 'hook'
  | 'decision'

export type ItemStatus = 'pending' | 'streaming' | 'completed' | 'failed' | 'stopped'

export interface Item {
  id: string
  sessionId: string
  turnId?: string
  parentItemId?: string
  kind: ItemKind
  status: ItemStatus
  text?: string
  name?: string
  input?: unknown
  path?: string
  diff?: string
  exitCode?: number
  agentId?: string
  // outcome is set for finished hooks.
  outcome?: 'success' | 'blocked' | 'error'
  // decision is how the user resolved an agent request (decision items).
  decision?: 'approved' | 'denied' | 'answered'
  // images are the ids of pictures attached to a user message.
  images?: string[]
}

export interface Delta {
  itemId: string
  text: string
}

export interface TurnResult {
  text?: string
  isError?: boolean
  error?: string
  costUsd?: number
  inputTokens?: number
  outputTokens?: number
  // interruptionReason is set when the turn was cut short (see Interruption).
  interruptionReason?: string
  // stopped: the owner stopped the turn.
  stopped?: boolean
}

export type EventType =
  | 'session.state'
  | 'session.removed'
  | 'turn.started'
  | 'turn.ended'
  | 'item.updated'
  | 'text.delta'
  | 'request.opened'
  | 'request.resolved'
  | 'subagent.spawned'
  | 'quota'
  | 'usage'

export type RequestKind = 'permission' | 'question' | 'elicitation'
export type RequestState = 'pending' | 'resolved' | 'stale'

export interface RequestPayload {
  toolName?: string
  input?: RequestInput
  suggestions?: unknown
  toolUseId?: string
  agentId?: string
}

export interface RequestInput {
  questions?: Question[]
  [key: string]: unknown
}

export interface Question {
  question: string
  header?: string
  multiSelect?: boolean
  options?: { label: string; description?: string; preview?: string }[]
}

export interface SessionRequest {
  id: string
  sessionId: string
  turnId?: string
  itemId?: string
  kind: RequestKind
  title?: string
  prompt?: string
  payload?: RequestPayload
  state: RequestState
  answer?: unknown
}

export interface RequestAnswerInput {
  behavior: 'allow' | 'deny'
  message?: string
  allowForSession?: boolean
  answers?: Record<string, string[]>
  content?: Record<string, unknown>
}

export interface SessionEvent {
  seq: number
  sessionId: string
  type: EventType
  session?: Session
  item?: Item
  delta?: Delta
  request?: SessionRequest
  result?: TurnResult
  quota?: QuotaSnapshot
  usage?: Usage
}

export async function fetchHealth(): Promise<Health> {
  return withDeadline(undefined, TIMEOUT_MS, async (signal) => {
    try {
      const res = await fetch('/api/health', { credentials: 'same-origin', signal })
      if (res.status === 401) return 'unauthorized'
      if (!res.ok) return 'offline'
      const body = (await res.json()) as { status?: string }
      return body.status === 'ok' ? 'online' : 'offline'
    } catch {
      return 'offline'
    }
  })
}

// UNAUTHORIZED_EVENT fires on window when the API rejects the login (the
// cookie expired or the token changed), so the page can show "Signed out".
export const UNAUTHORIZED_EVENT = 'gc:unauthorized'

// TIMEOUT_MS is how long a request may take before it counts as unanswered,
// so a hung server never leaves a control reading "Sending…" for good.
export const TIMEOUT_MS = 30_000
// SLOW_MS is for calls that start an agent CLI or wait on one.
const SLOW_MS = 90_000
// LONG_MS is for calls that move a lot: a git worktree, an uploaded picture.
const LONG_MS = 5 * 60_000

// ApiError is a request the server answered with a failure status.
export class ApiError extends Error {
  readonly status: number
  // code tells apart refusals that share a status (folder_gone, cli_missing).
  readonly code?: string

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.status = status
    this.name = 'ApiError'
    if (code) this.code = code
  }
}

// errorCode reads the refusal's code from a failed response's body.
function errorCode(body: string): string | undefined {
  try {
    const code = (JSON.parse(body) as { code?: unknown } | null)?.code
    return typeof code === 'string' && code ? code : undefined
  } catch {
    return undefined
  }
}

// errorMessage turns a failed response's body into the message to show:
// the server answers {"error":"…"}, and the owner should read the reason,
// not the JSON around it. Any other body is kept whole for describeError.
export function errorMessage(body: string, status: string): string {
  if (!body) return status
  try {
    const parsed: unknown = JSON.parse(body)
    const reason = (parsed as { error?: unknown } | null)?.error
    if (typeof reason === 'string' && reason) return reason
  } catch {
    // Not JSON: an HTML page or plain text.
  }
  return body
}

// withDeadline runs fn with a signal that aborts after ms (reason: a
// TimeoutError) or when the caller's own signal does, whichever is first.
async function withDeadline<T>(outer: AbortSignal | null | undefined, ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException('go-chamber did not answer in time', 'TimeoutError')), ms)
  const follow = () => controller.abort(outer?.reason)
  if (outer?.aborted) follow()
  else outer?.addEventListener('abort', follow, { once: true })
  try {
    return await fn(controller.signal)
  } finally {
    clearTimeout(timer)
    outer?.removeEventListener('abort', follow)
  }
}

function signedOut(): never {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
  throw new Error('Signed out')
}

// requestRaw fetches path and hands back the response for the caller to
// read (a file, a status of its own), with the same login handling and
// deadline as the JSON calls. The deadline covers the headers only.
export async function requestRaw(path: string, init?: RequestInit, timeoutMs = TIMEOUT_MS): Promise<Response> {
  const res = await withDeadline(init?.signal, timeoutMs, (signal) => fetch(path, { credentials: 'same-origin', ...init, signal }))
  if (res.status === 401) signedOut()
  return res
}

async function request<T>(path: string, init?: RequestInit, timeoutMs = TIMEOUT_MS): Promise<T> {
  const [status, statusText, text] = await withDeadline(init?.signal, timeoutMs, async (signal) => {
    const res = await fetch(path, { credentials: 'same-origin', ...init, signal })
    const text = await res.text().catch((err: unknown) => {
      // A body cut off by the deadline is a timeout, not an empty answer.
      if (signal.aborted) throw err
      return ''
    })
    return [res.status, res.statusText, text] as const
  })
  if (status === 401) signedOut()
  if (status < 200 || status > 299) {
    throw new ApiError(status, errorMessage(text, `${status} ${statusText}`), errorCode(text))
  }
  return (text ? JSON.parse(text) : undefined) as T
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export function listSessions(): Promise<Session[]> {
  return request<Session[]>('/api/sessions')
}

export interface ModelChoice {
  model: string
  effort: string
}

export function createSession(agent: AgentKind, cwd: string, choice?: ModelChoice): Promise<Session> {
  return request<Session>('/api/sessions', json({ agent, cwd, ...choice }), SLOW_MS)
}

export function getSession(id: string): Promise<Session> {
  return request<Session>(`/api/sessions/${encodeURIComponent(id)}`)
}

export function sendMessage(id: string, text: string, images?: string[]): Promise<void> {
  return request<void>(`/api/sessions/${encodeURIComponent(id)}/messages`, json(images?.length ? { text, images } : { text }))
}

export interface UploadedImage {
  id: string
  mimeType: string
}

export function uploadImage(sessionId: string, file: Blob): Promise<UploadedImage> {
  return request<UploadedImage>(`/api/sessions/${encodeURIComponent(sessionId)}/images`, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  }, LONG_MS)
}

export function imageUrl(sessionId: string, imageId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/images/${encodeURIComponent(imageId)}`
}

export function interrupt(id: string): Promise<void> {
  return request<void>(`/api/sessions/${encodeURIComponent(id)}/interrupt`, { method: 'POST' })
}

export function continueSession(id: string): Promise<void> {
  return request<void>(`/api/sessions/${encodeURIComponent(id)}/continue`, { method: 'POST' })
}

export function setAutoContinue(id: string, on: boolean): Promise<Session> {
  return request<Session>(`/api/sessions/${encodeURIComponent(id)}/auto-continue`, { method: 'POST', ...json({ on }) })
}

export function forkSession(id: string): Promise<Session> {
  return request<Session>(`/api/sessions/${encodeURIComponent(id)}/fork`, { method: 'POST' }, SLOW_MS)
}

export function fetchEvents(id: string, since = 0, signal?: AbortSignal): Promise<SessionEvent[]> {
  return request<SessionEvent[]>(`/api/sessions/${encodeURIComponent(id)}/events?since=${since}`, signal ? { signal } : undefined)
}

export function listRequests(): Promise<SessionRequest[]> {
  return request<SessionRequest[]>('/api/requests')
}

export function respondRequest(
  sessionId: string,
  requestId: string,
  answer: RequestAnswerInput,
): Promise<void> {
  return request<void>(
    `/api/sessions/${encodeURIComponent(sessionId)}/requests/${encodeURIComponent(requestId)}`,
    json(answer),
  )
}

export interface AccountInfo {
  agent: AgentKind
  loggedIn: boolean
  authMode?: string
  email?: string
  plan?: string
  // cliMissing: the agent's CLI is not installed, so its login is unknown.
  cliMissing?: boolean
}

// CLIStatus says whether the server found an agent's CLI on its PATH, and
// how to install a missing one.
export interface CLIStatus {
  agent: AgentKind
  found: boolean
  path?: string
  hint?: string
}

export function listAgents(): Promise<CLIStatus[]> {
  return request<CLIStatus[]>('/api/agents')
}

export interface LoginChallenge {
  loginId: string
  userCode: string
  url: string
}

export function getAccount(agent: AgentKind): Promise<AccountInfo> {
  return request<AccountInfo>(`/api/account?agent=${agent}`, undefined, SLOW_MS)
}

export function startLogin(agent: AgentKind): Promise<LoginChallenge> {
  return request<LoginChallenge>(`/api/agents/${agent}/login`, { method: 'POST' }, SLOW_MS)
}

export function steer(id: string, text: string): Promise<void> {
  return request<void>(`/api/sessions/${encodeURIComponent(id)}/steer`, json({ text }))
}

export function setApprovalReviewer(id: string, reviewer: ApprovalReviewer): Promise<Session> {
  return request<Session>(`/api/sessions/${encodeURIComponent(id)}/approval-reviewer`, json({ reviewer }))
}

export function renameSession(id: string, title: string): Promise<Session> {
  return request<Session>(`/api/sessions/${encodeURIComponent(id)}/title`, json({ title }))
}

// markSeen tells the server the owner looks at a session, having read up
// to item (none when they are not at the end).
export function markSeen(id: string, item?: string): Promise<Session> {
  return request<Session>(`/api/sessions/${encodeURIComponent(id)}/seen`, json(item ? { item } : {}))
}

// archiveSession puts a session away from the list; it keeps working.
export function archiveSession(id: string): Promise<Session> {
  return request<Session>(`/api/sessions/${encodeURIComponent(id)}/archive`, { method: 'POST' })
}

export function unarchiveSession(id: string): Promise<Session> {
  return request<Session>(`/api/sessions/${encodeURIComponent(id)}/unarchive`, { method: 'POST' })
}

// deleteSession removes go-chamber's record of a session; the agent's own
// transcript on disk stays.
export interface DeleteOptions {
  // removeWorktree takes the session's worktree folder too; its branch stays.
  removeWorktree?: boolean
}

export function deleteSession(id: string, opts?: DeleteOptions): Promise<void> {
  const query = opts?.removeWorktree ? '?worktree=remove' : ''
  return request<void>(`/api/sessions/${encodeURIComponent(id)}${query}`, { method: 'DELETE' }, opts?.removeWorktree ? LONG_MS : undefined)
}

export function setPermissionMode(id: string, mode: string): Promise<Session> {
  return request<Session>(`/api/sessions/${encodeURIComponent(id)}/permission-mode`, json({ mode }))
}

export function stopTask(id: string, taskId: string): Promise<void> {
  return request<void>(
    `/api/sessions/${encodeURIComponent(id)}/tasks/${encodeURIComponent(taskId)}/stop`,
    { method: 'POST' },
  )
}

export interface QuotaWindow {
  name: string
  usedPct: number
  resetsAt?: string
  status?: string
}

export interface QuotaSnapshot {
  agent: AgentKind
  windows: QuotaWindow[]
  plan?: string
  reached?: boolean
  updatedAt?: string
}

export interface Usage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  costUsd?: number
}

export function getQuotas(): Promise<QuotaSnapshot[]> {
  return request<QuotaSnapshot[]>('/api/quotas')
}

export function refreshQuota(agent: AgentKind): Promise<QuotaSnapshot> {
  return request<QuotaSnapshot>(`/api/quotas/${agent}/refresh`, { method: 'POST' }, SLOW_MS)
}

export interface Folder {
  name: string
  path: string
  repo?: boolean
}

export interface FolderListing {
  path: string
  parent?: string
  home: string
  folders: Folder[]
}

// listFolders browses the server's filesystem for the folder picker; an
// empty path means the home folder.
export function listFolders(path = '', hidden = false): Promise<FolderListing> {
  const q = new URLSearchParams()
  if (path) q.set('path', path)
  if (hidden) q.set('hidden', '1')
  const qs = q.toString()
  return request<FolderListing>(`/api/folders${qs ? `?${qs}` : ''}`)
}

export interface SearchHit {
  sessionId: string
  itemId: string
  // snippet wraps matches in [[ and ]].
  snippet: string
  matches: number
}

export function searchMessages(query: string): Promise<SearchHit[]> {
  return request<SearchHit[]>(`/api/search?${new URLSearchParams({ q: query })}`)
}

export interface ModelInfo {
  id: string
  name: string
  description?: string
  efforts?: string[]
  defaultEffort?: string
  default?: boolean
}

export function listModels(agent: AgentKind): Promise<ModelInfo[]> {
  return request<ModelInfo[]>(`/api/agents/${agent}/models`, undefined, SLOW_MS)
}

export function setModel(id: string, choice: ModelChoice): Promise<Session> {
  return request<Session>(`/api/sessions/${encodeURIComponent(id)}/model`, json(choice))
}

export interface FileChange {
  path: string
  // from is the path a renamed file (status R) had before.
  from?: string
  // status is git's letter (A, M, D, R, T) or '?' for an untracked file.
  status: string
  // added and removed count changed lines; a binary file counts none.
  added?: number
  removed?: number
  binary?: boolean
}

export interface Changes {
  repository: boolean
  // root is the repository's top folder; file paths are relative to it.
  root?: string
  base?: string
  files: FileChange[]
  // commits counts a worktree branch's commits since base.
  commits?: number
  // removed: the session's worktree folder is gone; branch is the one kept.
  removed?: boolean
  branch?: string
}

// createWorktreeSession starts a session in a new worktree on a new branch,
// or with existing on the branch that is already there.
export function createWorktreeSession(agent: AgentKind, cwd: string, branch: string, choice?: ModelChoice, existing?: boolean): Promise<Session> {
  return request<Session>('/api/worktrees', json({ agent, cwd, branch, ...choice, ...(existing ? { continue: true } : {}) }), LONG_MS)
}

export function getChanges(id: string): Promise<Changes> {
  return request<Changes>(`/api/sessions/${encodeURIComponent(id)}/changes`)
}

// Unmerged is a worktree branch a fork left behind (its parent's worktree
// was removed) with commits the repository's branch `into` lacks.
export interface Unmerged {
  branch: string
  into: string
  ahead: number
  // merge is the command that merges branch into `into`.
  merge: string
}

export async function getUnmerged(id: string): Promise<Unmerged | null> {
  const body = await request<{ unmerged: Unmerged | null }>(`/api/sessions/${encodeURIComponent(id)}/unmerged`)
  return body.unmerged
}

export function getFileDiff(id: string, path: string): Promise<{ diff: string }> {
  return request(`/api/sessions/${encodeURIComponent(id)}/changes/diff?path=${encodeURIComponent(path)}`)
}

export function removeWorktree(id: string, force: boolean): Promise<Session> {
  return request<Session>(`/api/sessions/${encodeURIComponent(id)}/worktree${force ? '?force=1' : ''}`, { method: 'DELETE' }, LONG_MS)
}

// ExternalSession is a conversation the agent recorded on its own (started
// in a terminal or another client) that can be opened here.
export interface ExternalSession {
  agent: AgentKind
  nativeId: string
  cwd: string
  title?: string
  updatedAt?: string
}

export function listHistory(): Promise<ExternalSession[]> {
  return request<ExternalSession[]>('/api/history')
}

export function importHistory(agent: AgentKind, nativeId: string): Promise<Session> {
  return request<Session>('/api/history/import', json({ agent, nativeId }), SLOW_MS)
}
