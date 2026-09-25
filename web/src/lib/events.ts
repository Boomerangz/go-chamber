import type { Item, SessionEvent, SessionRequest, SessionStatus, TurnResult, Usage } from './api'

export interface ChatState {
  items: Record<string, Item>
  order: string[]
  status: SessionStatus
  lastSeq: number
  result?: TurnResult
  usage?: Usage
  requests: Record<string, SessionRequest>
}

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
      return next
    case 'turn.ended':
      next.status = 'idle'
      if (ev.result) next.result = ev.result
      return next
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
