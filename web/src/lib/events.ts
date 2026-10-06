import type { Item, SessionEvent, SessionRequest, SessionStatus, TurnResult, Usage } from './api'
import { isBlank } from './tree'

export interface ChatState {
  items: Record<string, Item>
  order: string[]
  status: SessionStatus
  lastSeq: number
  result?: TurnResult
  // turnResults holds each finished turn's result by the id of the last
  // top-level item it showed.
  turnResults?: Record<string, TurnResult>
  usage?: Usage
  requests: Record<string, SessionRequest>
  // lastTurnFailed is true when the last turn ended with an error, so the
  // header can skip its "done" mark.
  lastTurnFailed?: boolean
}

// TURN_FAILED names the error item written for a turn that ended with an
// error (Claude reports those only in the turn result).
export const TURN_FAILED = 'turn failed'

export function initialChat(status: SessionStatus = 'detached'): ChatState {
  return { items: {}, order: [], status, lastSeq: 0, requests: {} }
}

// applyEvent folds one normalized session event into the chat state. Events
// older than the last seen sequence are ignored, which makes replay-after-
// reconnect idempotent.
export function applyEvent(state: ChatState, ev: SessionEvent): ChatState {
  if (ev.seq <= state.lastSeq) return state
  const next: ChatState = { ...state, lastSeq: ev.seq }
  switch (ev.type) {
    case 'item.updated':
      return ev.item ? upsert(next, ev.item) : next
    case 'text.delta':
      return ev.delta ? appendText(next, ev.delta.itemId, ev.delta.text) : next
    case 'session.state':
      if (ev.session) next.status = ev.session.status
      return next
    case 'turn.started':
      next.status = 'running'
      next.lastTurnFailed = false
      return next
    case 'turn.ended': {
      // A turn cut off (the agent exited, a restart) ended unfinished.
      next.status = ev.result?.interruptionReason ? 'interrupted' : 'idle'
      if (ev.result) next.result = ev.result
      const ended = endTurn(next, ev)
      return ev.result ? withTurnResult(ended, ev.result) : ended
    }
    case 'usage':
      if (ev.usage) next.usage = ev.usage
      return next
    case 'request.opened':
      return withRequest(next, ev.request)
    case 'request.resolved':
      return withoutRequest(next, ev.request?.id)
    default:
      return next
  }
}

// A replay or live flush owns its copies until the entire batch is folded.
// Avoid copying the whole transcript for each streamed text fragment.
export function applyEvents(state: ChatState, events: readonly SessionEvent[]): ChatState {
  let next = state
  let itemsCopied = false
  let orderCopied = false
  let ids: Set<string> | undefined
  for (const ev of events) {
    if (ev.seq <= next.lastSeq) continue
    if (ev.type !== 'item.updated' && ev.type !== 'text.delta') {
      next = applyEvent(next, ev)
      continue
    }
    next = { ...next, lastSeq: ev.seq }
    const item = ev.type === 'item.updated' ? ev.item : undefined
    const delta = ev.type === 'text.delta' ? ev.delta : undefined
    const previous = delta ? next.items[delta.itemId] : undefined
    if (!item && (!delta?.text || !previous)) continue
    if (!itemsCopied) {
      next.items = { ...next.items }
      itemsCopied = true
    }
    if (item) {
      ids ??= new Set(next.order)
      if (!ids.has(item.id)) {
        if (!orderCopied) {
          next.order = [...next.order]
          orderCopied = true
        }
        next.order.push(item.id)
        ids.add(item.id)
      }
      next.items[item.id] = item
    } else if (delta && previous) {
      next.items[delta.itemId] = { ...previous, text: (previous.text ?? '') + delta.text }
    }
  }
  return next
}

// endTurn notes whether the turn failed and writes the failure into the
// transcript, unless the agent already reported an error item in this turn
// (Codex does). An interrupted turn is shown by its banner and its foot, a
// stopped one by its foot.
function endTurn(state: ChatState, ev: SessionEvent): ChatState {
  const result = ev.result
  // A turn the owner stopped didn't fail; its foot says it was stopped.
  state.lastTurnFailed = !!result?.isError && !result.interruptionReason && !result.stopped
  if (!state.lastTurnFailed || reportedInTurn(state)) return state
  return upsert(state, {
    id: `turn-failed-${ev.seq}`,
    sessionId: ev.sessionId,
    kind: 'error',
    status: 'failed',
    name: TURN_FAILED,
    text: result?.error?.trim() || result?.text?.trim() || 'The turn ended with an error.',
  })
}

// withTurnResult files a turn's result under the last top-level item the
// transcript shows for it, where the turn's footer goes.
function withTurnResult(state: ChatState, result: TurnResult): ChatState {
  for (let i = state.order.length - 1; i >= 0; i--) {
    const item = state.items[state.order[i]!]
    if (!item || (item.parentItemId && state.items[item.parentItemId]) || isBlank(item)) continue
    return { ...state, turnResults: { ...state.turnResults, [item.id]: result } }
  }
  return state
}

function reportedInTurn(state: ChatState): boolean {
  for (let i = state.order.length - 1; i >= 0; i--) {
    const item = state.items[state.order[i]!]
    if (item?.kind === 'error') return true
    if (item?.kind === 'user_message') return false
  }
  return false
}

function withRequest(state: ChatState, request: SessionRequest | undefined): ChatState {
  if (!request) return state
  return { ...state, requests: { ...state.requests, [request.id]: request } }
}

function withoutRequest(state: ChatState, id: string | undefined): ChatState {
  if (!id || !(id in state.requests)) return state
  const requests = { ...state.requests }
  delete requests[id]
  return { ...state, requests }
}

function upsert(state: ChatState, item: Item): ChatState {
  const order = state.order.includes(item.id) ? state.order : [...state.order, item.id]
  return { ...state, order, items: { ...state.items, [item.id]: item } }
}

function appendText(state: ChatState, itemId: string, text: string): ChatState {
  const item = state.items[itemId]
  if (!item || !text) return state
  const merged: Item = { ...item, text: (item.text ?? '') + text }
  return { ...state, items: { ...state.items, [itemId]: merged } }
}
