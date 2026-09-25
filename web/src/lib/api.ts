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
  status: SessionStatus
  title?: string
  interruption?: Interruption
  approvalReviewer?: ApprovalReviewer
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

export function createSession(agent: AgentKind, cwd: string): Promise<Session> {
  return request<Session>('/api/sessions', json({ agent, cwd }))
}

export function getSession(id: string): Promise<Session> {
  return request<Session>(`/api/sessions/${encodeURIComponent(id)}`)
}

export function sendMessage(id: string, text: string): Promise<void> {
  return request<void>(`/api/sessions/${encodeURIComponent(id)}/messages`, json({ text }))
}

export function interrupt(id: string): Promise<void> {
  return request<void>(`/api/sessions/${encodeURIComponent(id)}/interrupt`, { method: 'POST' })
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
