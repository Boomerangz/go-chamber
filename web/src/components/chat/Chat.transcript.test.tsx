import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../../lib/api'
import { initialChat, TURN_FAILED, type ChatState } from '../../lib/events'
import { resetDrafts } from '../../stores/drafts'
import { useNotices } from '../../stores/notices'
import { resetStore, useSessionStore } from '../../stores/session'
import Chat from './Chat'

// The transcript's hook-ups in Chat: tool groups, retry, edit, turn footers.

vi.mock('../../lib/api', async (orig) => ({
  ...(await orig<typeof import('../../lib/api')>()),
  uploadImage: vi.fn(),
  listModels: vi.fn().mockResolvedValue([]),
}))

const session: api.Session = { id: 's1', agent: 'claude', cwd: '/p', status: 'idle' }

const item = (id: string, kind: api.ItemKind, extra: Partial<api.Item> = {}): api.Item => ({
  id, sessionId: 's1', kind, status: 'completed', text: id, ...extra,
})

function chatOf(items: api.Item[], extra: Partial<ChatState> = {}): ChatState {
  const chat = initialChat('idle')
  for (const it of items) {
    chat.items[it.id] = it
    chat.order.push(it.id)
  }
  return { ...chat, lastSeq: items.length || 1, ...extra }
}

let send: ReturnType<typeof vi.fn<(text: string, images?: string[]) => Promise<boolean>>>
function setup(chat: ChatState) {
  send = vi.fn(async () => true)
  useSessionStore.setState({ sessions: [session], activeId: 's1', chat, history: 'ready', connection: 'online', send })
  return render(<Chat />)
}

const box = () => screen.getByRole('combobox', { name: 'Message' }) as HTMLTextAreaElement

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('WebSocket', undefined)
  resetStore()
  resetDrafts()
  localStorage.clear()
  useNotices.setState({ notices: [] })
  Element.prototype.scrollIntoView = vi.fn()
})

describe('transcript hook-ups', () => {
  it('folds a run of finished tools into one line', () => {
    const { container } = setup(chatOf([
      item('u', 'user_message'),
      item('a', 'tool_call', { name: 'Read', input: { file_path: '/a' } }),
      item('b', 'tool_call', { name: 'Read', input: { file_path: '/b' } }),
      item('c', 'command', { input: { command: 'ls' }, exitCode: 0 }),
      item('m', 'assistant_message'),
    ]))
    expect(container.querySelector('.tool-group-label')).toHaveTextContent('Read 2 files · ran 1 command')
    expect(container.querySelectorAll('.items > li.row')).toHaveLength(3)
  })

  it('leaves an answered question to its record, without the raw tool line', () => {
    const { container } = setup(chatOf([
      item('u', 'user_message'),
      item('q', 'tool_call', { name: 'AskUserQuestion', input: { questions: [] }, text: 'answered: {}' }),
      item('d', 'decision', { name: 'Question', decision: 'answered', text: 'Which? Beta' }),
    ]))
    expect(screen.queryByText('AskUserQuestion')).toBeNull()
    expect(container.querySelector('.item.decision')).toHaveTextContent('Which? Beta')
  })

  it('sends the last message of a failed turn again, with its images', async () => {
    setup(chatOf([
      item('u', 'user_message', { text: 'do it', images: ['img1'] }),
      item('e', 'error', { status: 'failed', name: TURN_FAILED, text: 'overloaded' }),
    ]))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })))
    expect(send).toHaveBeenCalledWith('do it', ['img1'])
  })

  it('offers retry only on the error that ends the transcript and not while a turn runs', () => {
    const items = [item('u', 'user_message'), item('e', 'error', { status: 'failed' }), item('m', 'assistant_message')]
    const view = setup(chatOf(items))
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    view.unmount()
    setup(chatOf(items.slice(0, 2), { status: 'running' }))
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('takes a message back into the composer, after a draft already there', () => {
    setup(chatOf([item('u', 'user_message', { text: 'first try' })]))
    fireEvent.click(screen.getByRole('button', { name: 'Reuse' }))
    expect(box().value).toBe('first try')
    expect(box()).toHaveFocus()
    fireEvent.change(box(), { target: { value: 'draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Reuse' }))
    expect(box().value).toBe('draft\n\nfirst try')
  })

  it('numbers open requests when there are several', () => {
    const request = (id: string): api.SessionRequest => ({ id, sessionId: 's1', kind: 'permission', state: 'pending', title: id })
    setup(chatOf([item('u', 'user_message')], { requests: { r1: request('r1'), r2: request('r2') } }))
    expect(screen.getByText('· 1 of 2')).toBeInTheDocument()
    expect(screen.getByText('· 2 of 2')).toBeInTheDocument()
  })

  it('closes each finished turn with its usage', () => {
    const { container } = setup(chatOf([item('u', 'user_message'), item('m', 'assistant_message')], {
      turnResults: { m: { inputTokens: 100, outputTokens: 20 } },
    }))
    expect(container.querySelector('.turn-foot')).toHaveTextContent('100 in · 20 out')
  })
})
