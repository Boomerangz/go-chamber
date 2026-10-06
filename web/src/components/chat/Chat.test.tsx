import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../../lib/api'
import { initialChat, type ChatState } from '../../lib/events'
import { resetDrafts } from '../../stores/drafts'
import { useNotices } from '../../stores/notices'
import { resetStore, useSessionStore } from '../../stores/session'
import Chat from './Chat'

vi.mock('../../lib/api', async (orig) => ({
  ...(await orig<typeof import('../../lib/api')>()),
  uploadImage: vi.fn(),
  listModels: vi.fn().mockResolvedValue([]),
}))

const session: api.Session = { id: 's1', agent: 'claude', cwd: '/home/me/project', status: 'idle', nativeId: 'n1' }

const item = (id: string, kind: api.ItemKind, extra: Partial<api.Item> = {}): api.Item => ({
  id,
  sessionId: 's1',
  kind,
  status: 'completed',
  text: id,
  ...extra,
})

function chatOf(items: api.Item[], extra: Partial<ChatState> = {}): ChatState {
  const chat = initialChat('idle')
  for (const it of items) {
    chat.items[it.id] = it
    chat.order.push(it.id)
  }
  return { ...chat, lastSeq: items.length || 1, ...extra }
}

const actions = () => ({
  send: vi.fn(async () => true),
  steer: vi.fn(async () => true),
  interrupt: vi.fn(async () => true),
  forkSession: vi.fn(async () => true),
  setApprovalReviewer: vi.fn(async () => true),
  selectSession: vi.fn(async () => {}),
  continueSession: vi.fn(async () => true),
  loadModels: vi.fn(async () => {}),
})

let fns: ReturnType<typeof actions>
function setup(state: Partial<ReturnType<typeof useSessionStore.getState>> = {}) {
  fns = actions()
  useSessionStore.setState({
    sessions: [session],
    activeId: 's1',
    chat: chatOf([]),
    history: 'ready',
    connection: 'online',
    ...fns,
    ...state,
  })
  return render(<Chat />)
}

const box = () => screen.getByRole('combobox', { name: 'message' })
const running = (items: api.Item[] = [], extra: Partial<ChatState> = {}) => chatOf(items, { status: 'running', ...extra })

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('WebSocket', undefined)
  resetStore()
  resetDrafts()
  localStorage.clear()
  useNotices.setState({ notices: [] })
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('transcript loading', () => {
  it('shows placeholder rows while the transcript loads, not the start hint', () => {
    setup({ history: 'loading', chat: initialChat() })
    expect(screen.getByRole('status', { name: 'loading transcript' })).toBeInTheDocument()
    expect(screen.queryByText(/Send a message to start/)).toBeNull()
  })

  it('offers to retry a transcript that did not load', async () => {
    setup({ history: 'error', chat: initialChat() })
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load the transcript")
    expect(screen.queryByText(/Send a message to start/)).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(fns.selectSession).toHaveBeenCalledWith('s1')
  })

  it('invites the first message once an empty transcript loaded', () => {
    setup()
    expect(screen.getByText(/Send a message to start/)).toBeInTheDocument()
  })

  it('shows the session status where a screen reader can follow it', () => {
    setup({ chat: chatOf([item('u1', 'user_message')]) })
    expect(screen.getByRole('list', { name: 'transcript' })).toBeInTheDocument()
    expect(document.querySelector('.chat-meta .status')).toHaveAttribute('role', 'status')
    expect(document.querySelector('.chat-meta .status')).toHaveTextContent('idle')
  })

  it('flashes "done" for a finished turn but not for a failed one', () => {
    setup({ chat: running([item('u1', 'user_message')]) })
    act(() => useSessionStore.setState({ chat: chatOf([item('u1', 'user_message')], { lastSeq: 5 }) }))
    expect(document.querySelector('.chat-meta .status')).toHaveTextContent('done')
    act(() => useSessionStore.setState({ chat: running([item('u1', 'user_message')], { lastSeq: 6 }) }))
    act(() => useSessionStore.setState({ chat: chatOf([item('u1', 'user_message')], { lastSeq: 7, lastTurnFailed: true }) }))
    expect(document.querySelector('.chat-meta .status')).toHaveTextContent('idle')
  })
})

describe('working tail', () => {
  it('shows the turn clock while the agent works and nothing streams', () => {
    vi.useFakeTimers()
    setup({ chat: running([item('u1', 'user_message')]) })
    expect(screen.getByText('working · 0:00')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(42_000))
    expect(screen.getByText('working · 0:42')).toBeInTheDocument()
  })

  it('steps aside while text streams', () => {
    setup({ chat: running([item('a1', 'assistant_message', { status: 'streaming' })]) })
    expect(screen.queryByText(/working ·/)).toBeNull()
  })

  it('says the turn waits for the owner when a request is open', () => {
    const request: api.SessionRequest = { id: 'r1', sessionId: 's1', kind: 'permission', state: 'pending', title: 'Run' }
    setup({ chat: running([item('u1', 'user_message')], { requests: { r1: request } }) })
    expect(screen.getByText('waiting for you')).toBeInTheDocument()
    expect(screen.queryByText(/working ·/)).toBeNull()
  })
})

describe('sending', () => {
  it('cannot send nothing', async () => {
    setup()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    await userEvent.type(box(), 'hi')
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled()
  })

  it('says it is sending, then steers a quick second message before the turn shows up', async () => {
    let accept: (ok: boolean) => void = () => {}
    setup()
    fns.send.mockImplementationOnce(() => new Promise<boolean>((r) => (accept = r)))
    await userEvent.type(box(), 'first')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    const button = screen.getByRole('button', { name: 'Sending…' })
    expect(button).toHaveAttribute('aria-busy', 'true')
    await act(async () => accept(true))
    expect(box()).toHaveValue('')
    expect(box()).toHaveFocus()
    expect(screen.getByRole('button', { name: 'Steer' })).toBeInTheDocument()
    await userEvent.type(box(), 'second')
    await userEvent.click(screen.getByRole('button', { name: 'Steer' }))
    expect(fns.steer).toHaveBeenCalledWith('second')
  })

  it('goes back to Send when the started turn already ended', async () => {
    setup()
    await userEvent.type(box(), 'first')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    act(() => useSessionStore.setState({ chat: chatOf([item('u1', 'user_message')], { result: { text: 'ok' } }) }))
    await userEvent.type(box(), 'next')
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
  })

  it('waits for images still uploading', async () => {
    vi.mocked(api.uploadImage).mockImplementation(() => new Promise(() => {}))
    setup()
    await userEvent.type(box(), 'look')
    await userEvent.upload(screen.getByLabelText('attach images'), new File(['x'], 'a.png', { type: 'image/png' }))
    const button = screen.getByRole('button', { name: 'Uploading…' })
    expect(button).toHaveAttribute('aria-busy', 'true')
    await userEvent.click(button)
    expect(fns.send).not.toHaveBeenCalled()
  })

  it('keeps the draft of each session across remounts and drops it once sent', async () => {
    const first = setup()
    await userEvent.type(box(), 'half a thought')
    first.unmount()
    setup()
    expect(box()).toHaveValue('half a thought')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(box()).toHaveValue(''))
    expect(localStorage.getItem('gc.draft:s1')).toBeNull()
  })

  it('brings the last message back with ArrowUp', async () => {
    setup({ chat: chatOf([item('u1', 'user_message', { text: 'fix the tests' }), item('a1', 'assistant_message')]) })
    box().focus()
    await userEvent.keyboard('{ArrowUp}')
    expect(box()).toHaveValue('fix the tests')
  })

  it('names the send shortcut on the button and beside it', async () => {
    setup()
    await userEvent.type(box(), 'hi')
    expect(screen.getByRole('button', { name: 'Send' })).toHaveAttribute('title', 'Send (↵)')
    expect(document.querySelector('.composer-keys')).toHaveTextContent('↵ send · ⇧↵ newline')
  })

  it('sends with Enter', async () => {
    setup()
    await userEvent.type(box(), 'go{Enter}')
    expect(fns.send).toHaveBeenCalledWith('go', [])
  })

  it('says how long a long message is', () => {
    localStorage.setItem('gc.draft:s1', Array.from({ length: 21 }, (_, i) => `line ${i}`).join('\n'))
    setup()
    expect(document.querySelector('.composer-lines')).toHaveTextContent('21 lines')
  })

  it('stays quiet about length for a short message', async () => {
    setup()
    await userEvent.type(box(), 'one{Shift>}{Enter}{/Shift}two')
    expect(document.querySelector('.composer-lines')).toBeNull()
  })

  it('walks back through the messages sent in this session', async () => {
    setup({ chat: chatOf([item('u1', 'user_message', { text: 'first' }), item('a1', 'assistant_message'), item('u2', 'user_message', { text: 'second' })]) })
    box().focus()
    await userEvent.keyboard('{ArrowUp}{ArrowUp}')
    expect(box()).toHaveValue('first')
  })

  it('takes images only with a new message, not a steer', () => {
    setup({ chat: running() })
    expect(screen.getByRole('button', { name: 'Attach' })).toHaveAttribute('title', 'Images go with the next message')
  })
})

describe('stopping', () => {
  it('stays "Stopping…" until the turn leaves running', async () => {
    setup({ chat: running([item('u1', 'user_message')]) })
    const stop = screen.getByRole('button', { name: 'Stop' })
    expect(stop.title).toMatch(/^Stop \(Esc/)
    await userEvent.click(stop)
    expect(fns.interrupt).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Stopping…' })).toHaveAttribute('aria-busy', 'true')
    await userEvent.click(screen.getByRole('button', { name: 'Stopping…' }))
    expect(fns.interrupt).toHaveBeenCalledTimes(1)
    act(() => useSessionStore.setState({ chat: chatOf([item('u1', 'user_message')], { status: 'interrupted' }) }))
    expect(screen.queryByRole('button', { name: /Stop/ })).toBeNull()
  })

  it('stops with Escape in an empty composer', async () => {
    setup({ chat: running() })
    box().focus()
    await userEvent.keyboard('{Escape}')
    expect(fns.interrupt).toHaveBeenCalledTimes(1)
  })

  it('leaves an empty idle composer with Escape, so single-key shortcuts work', async () => {
    setup({})
    box().focus()
    await userEvent.keyboard('{Escape}')
    expect(box()).not.toHaveFocus()
    expect(fns.interrupt).not.toHaveBeenCalled()
  })

  it('does not stop with Escape while there is text', async () => {
    setup({ chat: running() })
    await userEvent.type(box(), 'wait')
    await userEvent.keyboard('{Escape}')
    expect(fns.interrupt).not.toHaveBeenCalled()
  })

  it('stops with Ctrl+. anywhere', () => {
    setup({ chat: running() })
    fireEvent.keyDown(window, { key: '.', ctrlKey: true })
    expect(fns.interrupt).toHaveBeenCalledTimes(1)
  })

  it('ignores Ctrl+. when nothing runs', () => {
    setup()
    fireEvent.keyDown(window, { key: '.', ctrlKey: true })
    expect(fns.interrupt).not.toHaveBeenCalled()
  })
})

describe('header', () => {
  it('forks once, showing it is forking', async () => {
    setup()
    fns.forkSession.mockImplementationOnce(() => new Promise(() => {}))
    await userEvent.click(screen.getByRole('button', { name: 'Fork' }))
    const button = screen.getByRole('button', { name: 'Forking…' })
    expect(button).toHaveAttribute('aria-busy', 'true')
    await userEvent.click(button)
    expect(fns.forkSession).toHaveBeenCalledTimes(1)
  })

  it('shows the reviewer choice at once and reverts a refused one', async () => {
    let done: (ok: boolean) => void = () => {}
    setup({ sessions: [{ ...session, agent: 'codex', approvalReviewer: 'user' }] })
    fns.setApprovalReviewer.mockImplementationOnce(() => new Promise<boolean>((r) => (done = r)))
    const select = screen.getByLabelText('approval reviewer')
    await userEvent.selectOptions(select, 'auto_review')
    expect(select).toHaveValue('auto_review')
    expect(select).toHaveAttribute('aria-busy', 'true')
    await act(async () => done(false))
    expect(select).toHaveValue('user')
  })

  it('folds the folder and settings behind a details button', async () => {
    setup()
    const more = screen.getByRole('button', { name: 'session details' })
    expect(more).toHaveAttribute('aria-expanded', 'false')
    expect(document.getElementById(more.getAttribute('aria-controls')!)).toContainElement(screen.getByLabelText('permission mode'))
    await userEvent.click(more)
    expect(more).toHaveAttribute('aria-expanded', 'true')
    expect(document.querySelector('.chat-header')).toHaveAttribute('data-details', 'open')
  })

  it('marks a session the agent runs without approvals', () => {
    setup({ sessions: [{ ...session, permissionMode: 'bypassPermissions' }] })
    expect(document.querySelector('.chat-meta .no-approvals')).toHaveTextContent('no approvals')
  })

  it('has no unguarded mark in an asking mode', () => {
    setup({ sessions: [{ ...session, permissionMode: 'default' }] })
    expect(document.querySelector('.no-approvals')).toBeNull()
  })

  it('copies the session folder', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    setup()
    expect(screen.getByText('/home/me/project')).toHaveAttribute('title', '/home/me/project')
    await userEvent.click(screen.getByRole('button', { name: 'copy path' }))
    expect(writeText).toHaveBeenCalledWith('/home/me/project')
    expect(useNotices.getState().notices.at(-1)?.text).toBe('Path copied')
  })
})

describe('scrolling', () => {
  function scroller() {
    const el = document.querySelector('.scroll') as HTMLDivElement
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 2000 })
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 400 })
    return el
  }

  it('counts what arrived while scrolled up and jumps back to it', async () => {
    const items = [item('u1', 'user_message'), item('a1', 'assistant_message')]
    setup({ chat: chatOf(items) })
    const el = scroller()
    el.scrollTop = 100
    fireEvent.scroll(el)
    act(() => useSessionStore.setState({ chat: chatOf([...items, item('a2', 'assistant_message'), item('a3', 'assistant_message')]) }))
    const jump = screen.getByRole('button', { name: /latest/ })
    expect(jump).toHaveTextContent('latest 2')
    await userEvent.click(jump)
    expect(el.scrollTop).toBe(2000)
    expect(screen.queryByRole('button', { name: /latest/ })).toBeNull()
  })

  it('opens on the "new since you left" mark rather than the end', () => {
    localStorage.setItem('go-chamber:seen:s1', 'u1')
    setup({ history: 'loading', chat: initialChat() })
    act(() =>
      useSessionStore.setState({
        history: 'ready',
        chat: chatOf([item('u1', 'user_message'), item('a1', 'assistant_message'), item('a2', 'assistant_message')]),
      }),
    )
    const mark = screen.getByLabelText('New since your last visit')
    expect(mark.scrollIntoView).toHaveBeenCalledWith({ block: 'start' })
    // Not read yet: the end is out of view.
    expect(localStorage.getItem('go-chamber:seen:s1')).toBe('u1')
  })
})

const permission = (id: string): api.SessionRequest => ({ id, sessionId: 's1', kind: 'permission', state: 'pending', title: `Run ${id}` })

// pointerFine makes the page read as a desktop with a mouse.
function pointerFine() {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('pointer: fine'),
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

describe('answering requests', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('moves focus to the next pending card once an answer went through', async () => {
    const respond = vi.fn(async () => true)
    setup({ chat: running([item('u1', 'user_message')], { requests: { r1: permission('r1'), r2: permission('r2') } }), respond })
    await userEvent.click(screen.getAllByRole('button', { name: 'Allow' })[0]!)
    expect(respond).toHaveBeenCalledWith('s1', 'r1', expect.anything())
    await waitFor(() => expect(document.activeElement).toHaveAttribute('data-request-id', 'r2'))
  })

  it('returns focus to the composer after the last one', async () => {
    pointerFine()
    const respond = vi.fn(async () => true)
    setup({ chat: running([item('u1', 'user_message')], { requests: { r1: permission('r1') } }), respond })
    await userEvent.click(screen.getByRole('button', { name: 'Allow' }))
    await waitFor(() => expect(box()).toHaveFocus())
  })

  it('leaves focus where it is when the answer failed', async () => {
    pointerFine()
    const respond = vi.fn(async () => false)
    setup({ chat: running([item('u1', 'user_message')], { requests: { r1: permission('r1'), r2: permission('r2') } }), respond })
    await userEvent.click(screen.getAllByRole('button', { name: 'Allow' })[0]!)
    expect(document.activeElement).not.toHaveAttribute('data-request-id', 'r2')
    expect(box()).not.toHaveFocus()
  })
})

describe('pending message', () => {
  const pendingRow = () => document.querySelector('.row-pending')

  it('shows what was sent at once, until the agent records it', async () => {
    let accept: (ok: boolean) => void = () => {}
    setup()
    fns.send.mockImplementationOnce(() => new Promise<boolean>((r) => (accept = r)))
    await userEvent.type(box(), 'hello there')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(pendingRow()).toHaveTextContent('hello there')
    expect(pendingRow()).toHaveTextContent('sending')
    await act(async () => accept(true))
    expect(pendingRow()).toHaveTextContent('hello there')
    act(() => useSessionStore.setState({ chat: chatOf([item('u1', 'user_message', { text: 'hello there' })]) }))
    expect(pendingRow()).toBeNull()
  })

  it('goes away and keeps the draft when the message was not sent', async () => {
    let accept: (ok: boolean) => void = () => {}
    setup()
    fns.send.mockImplementationOnce(() => new Promise<boolean>((r) => (accept = r)))
    await userEvent.type(box(), 'try me')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    await act(async () => accept(false))
    expect(pendingRow()).toBeNull()
    expect(box()).toHaveValue('try me')
  })

  it('does not wait forever for an echo that never comes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    setup()
    await userEvent.type(box(), 'lost')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await act(async () => {})
    expect(pendingRow()).not.toBeNull()
    act(() => vi.advanceTimersByTime(30_000))
    expect(pendingRow()).toBeNull()
  })
})

describe('live connection', () => {
  it('says live updates paused and reconnects on demand', async () => {
    const retryNow = vi.fn()
    setup({ chat: running([item('u1', 'user_message')]), connection: 'offline', nextRetryAt: Date.now() + 4500, retryNow })
    expect(screen.getByRole('status', { name: 'live updates' })).toHaveTextContent(/live updates paused · reconnecting in [45]s/)
    await userEvent.click(screen.getByRole('button', { name: 'Reconnect now' }))
    expect(retryNow).toHaveBeenCalledTimes(1)
  })

  it('says it is reconnecting while a retry is on its way', () => {
    setup({ connection: 'connecting', nextRetryAt: Date.now() - 10 })
    expect(screen.getByRole('status', { name: 'live updates' })).toHaveTextContent('reconnecting…')
  })

  it('stays quiet while the first connection opens', () => {
    setup({ connection: 'connecting', nextRetryAt: null })
    expect(screen.queryByRole('status', { name: 'live updates' })).toBeNull()
  })

  it('stops the turn clock: it cannot know the turn still runs', () => {
    setup({ chat: running([item('u1', 'user_message')]), connection: 'offline', nextRetryAt: null })
    expect(screen.queryByText(/working ·/)).toBeNull()
    expect(screen.getByText('last seen working')).toBeInTheDocument()
  })
})

describe('session not loaded yet', () => {
  it('holds the heading as a placeholder while sessions load', () => {
    setup({ sessions: [], sessionsStatus: 'loading', history: 'loading', chat: initialChat() })
    expect(screen.queryByRole('heading', { name: 'Session' })).toBeNull()
    expect(screen.getByRole('status', { name: 'loading session' })).toBeInTheDocument()
  })

  it('says a session that does not exist was not found and leads back', async () => {
    setup({ sessions: [], sessionsStatus: 'ready', history: 'error', chat: initialChat() })
    expect(screen.getByRole('heading', { name: 'Session not found' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Back to sessions' }))
    expect(useSessionStore.getState().activeId).toBeNull()
    expect(useSessionStore.getState().pane).toBe('sessions')
  })
})

describe('jump to latest', () => {
  function scroller() {
    const el = document.querySelector('.scroll') as HTMLDivElement
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 2000 })
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 400 })
    return el
  }

  it('is there whenever the end is out of view, without a number when nothing is new', () => {
    setup({ chat: chatOf([item('u1', 'user_message'), item('a1', 'assistant_message')]) })
    const el = scroller()
    el.scrollTop = 100
    fireEvent.scroll(el)
    expect(screen.getByRole('button', { name: /latest/ })).toHaveTextContent(/^latest$/)
  })

  it('counts replies and requests, not every tool line', () => {
    const items = [item('u1', 'user_message')]
    setup({ chat: chatOf(items) })
    const el = scroller()
    el.scrollTop = 100
    fireEvent.scroll(el)
    act(() =>
      useSessionStore.setState({
        chat: chatOf([...items, item('t1', 'tool_call'), item('t2', 'command'), item('a1', 'assistant_message')], {
          requests: { r1: permission('r1') },
        }),
      }),
    )
    expect(screen.getByRole('button', { name: /latest/ })).toHaveTextContent('latest 2')
  })
})

describe('working tail while text streams', () => {
  it('keeps the clock and drops only the word', () => {
    setup({ chat: running([item('a1', 'assistant_message', { status: 'streaming' })]) })
    expect(screen.queryByText(/working/)).toBeNull()
    expect(document.querySelector('.working-tail')).toHaveTextContent('0:00')
  })
})

describe('screen reader', () => {
  const announced = () => document.querySelector('.chat-announce')

  it('keeps the transcript out of the live region and announces what matters', () => {
    setup({ chat: running([item('u1', 'user_message')]) })
    const list = document.querySelector('ol.items')!
    expect(list).not.toHaveAttribute('aria-live')
    expect(list).not.toHaveAttribute('role', 'log')
    act(() => useSessionStore.setState({ chat: running([item('u1', 'user_message'), item('a1', 'assistant_message', { status: 'streaming' })]) }))
    expect(announced()).toHaveTextContent('')
    act(() => useSessionStore.setState({ chat: running([item('u1', 'user_message'), item('a1', 'assistant_message')]) }))
    expect(announced()).toHaveTextContent('assistant replied')
    act(() =>
      useSessionStore.setState({
        chat: running([item('u1', 'user_message'), item('a1', 'assistant_message')], { requests: { r1: permission('r1') } }),
      }),
    )
    expect(announced()).toHaveTextContent('approval needed')
    act(() => useSessionStore.setState({ chat: chatOf([item('u1', 'user_message'), item('a1', 'assistant_message')], { lastSeq: 9 }) }))
    expect(announced()).toHaveTextContent('turn finished')
  })

  it('does not read out a transcript as it loads', () => {
    setup({ history: 'loading', chat: initialChat() })
    act(() => useSessionStore.setState({ history: 'ready', chat: chatOf([item('u1', 'user_message'), item('a1', 'assistant_message')]) }))
    expect(announced()).toHaveTextContent('')
  })
})

describe('first message hint', () => {
  it('lists what the composer understands', () => {
    setup()
    expect(document.querySelector('.chat-hint-keys')).toHaveTextContent('@ file · / commands · paste or drop images')
  })
})

describe('approval reviewer', () => {
  it('shows a busy mark while saving, like the mode select', async () => {
    setup({ sessions: [{ ...session, agent: 'codex', approvalReviewer: 'user' }] })
    fns.setApprovalReviewer.mockImplementationOnce(() => new Promise<boolean>(() => {}))
    await userEvent.selectOptions(screen.getByLabelText('approval reviewer'), 'auto_review')
    expect(screen.getByLabelText('approval reviewer').closest('.reviewer')?.querySelector('.busy-mark')).not.toBeNull()
  })
})

describe('stop when the agent is quiet', () => {
  it('lets go of "Stopping…" after a while and says the stop was sent', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    setup({ chat: running([item('u1', 'user_message')]) })
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await act(async () => {})
    expect(screen.getByRole('button', { name: 'Stopping…' })).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(10_000))
    expect(screen.getByRole('button', { name: 'Stop' })).not.toHaveAttribute('aria-busy', 'true')
    expect(screen.getByText('sent · waiting for agent')).toBeInTheDocument()
  })

  it('lets go at once when the live connection drops', async () => {
    setup({ chat: running([item('u1', 'user_message')]) })
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(screen.getByRole('button', { name: 'Stopping…' })).toBeInTheDocument()
    act(() => useSessionStore.setState({ connection: 'offline' }))
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
    expect(screen.getByText('sent · waiting for agent')).toBeInTheDocument()
  })
})
