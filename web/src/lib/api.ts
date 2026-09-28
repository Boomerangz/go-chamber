export type Health = 'online' | 'offline' | 'unauthorized'

export type AgentKind = 'claude' | 'codex'
export type SessionStatus = 'detached' | 'idle' | 'running' | 'interrupted'

export interface Interruption {
  reason?: string
  resumeAfter?: string
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
}

export interface Worktree {
  repo: string
  path: string
  branch: string
  base: string
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

export type ItemStatus = 'pending' | 'streaming' | 'completed' | 'failed'

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
}

export type EventType =
  | 'session.state'
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
  try {
    const res = await fetch('/api/health', { credentials: 'same-origin' })
    if (res.status === 401) return 'unauthorized'
    if (!res.ok) return 'offline'
    const body = (await res.json()) as { status?: string }
    return body.status === 'ok' ? 'online' : 'offline'
  } catch {
    return 'offline'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', ...init })
  const text = await res.text().catch(() => '')
  if (!res.ok) {
    throw new Error(text || `${res.status} ${res.statusText}`)
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
  return request<Session>('/api/sessions', json({ agent, cwd, ...choice }))
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
  })
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
  return request<Session>(`/api/sessions/${encodeURIComponent(id)}/fork`, { method: 'POST' })
}

export function fetchEvents(id: string, since = 0): Promise<SessionEvent[]> {
  return request<SessionEvent[]>(`/api/sessions/${encodeURIComponent(id)}/events?since=${since}`)
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
}

export interface LoginChallenge {
  loginId: string
  userCode: string
  url: string
}

export function getAccount(agent: AgentKind): Promise<AccountInfo> {
  return request<AccountInfo>(`/api/account?agent=${agent}`)
}

export function startLogin(agent: AgentKind): Promise<LoginChallenge> {
  return request<LoginChallenge>(`/api/agents/${agent}/login`, { method: 'POST' })
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
  return request<QuotaSnapshot>(`/api/quotas/${agent}/refresh`, { method: 'POST' })
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
  return request<ModelInfo[]>(`/api/agents/${agent}/models`)
}

export function setModel(id: string, choice: ModelChoice): Promise<Session> {
  return request<Session>(`/api/sessions/${encodeURIComponent(id)}/model`, json(choice))
}

export interface FileChange {
  path: string
  // status is git's letter (A, M, D, T) or '?' for an untracked file.
  status: string
}

export interface Changes {
  repository: boolean
  base?: string
  files: FileChange[]
}

export function createWorktreeSession(agent: AgentKind, cwd: string, branch: string, choice?: ModelChoice): Promise<Session> {
  return request<Session>('/api/worktrees', json({ agent, cwd, branch, ...choice }))
}

export function getChanges(id: string): Promise<Changes> {
  return request<Changes>(`/api/sessions/${encodeURIComponent(id)}/changes`)
}

export function getFileDiff(id: string, path: string): Promise<{ diff: string }> {
  return request(`/api/sessions/${encodeURIComponent(id)}/changes/diff?path=${encodeURIComponent(path)}`)
}

export function removeWorktree(id: string, force: boolean): Promise<Session> {
  return request<Session>(`/api/sessions/${encodeURIComponent(id)}/worktree${force ? '?force=1' : ''}`, { method: 'DELETE' })
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
  return request<Session>('/api/history/import', json({ agent, nativeId }))
}
