import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../../lib/api'
import { initialChat, type ChatState } from '../../lib/events'
import { resetDrafts } from '../../stores/drafts'
import { notify, useNotices } from '../../stores/notices'
import { resetStore, useSessionStore } from '../../stores/session'
import Chat from './Chat'

vi.mock('../../lib/home', () => ({ useHome: () => '/home/me' }))
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

const box = () => screen.getByRole('combobox', { name: 'Message' })
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
    expect(screen.getByRole('status', { name: 'Loading transcript' })).toBeInTheDocument()
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
    expect(screen.getByRole('list', { name: 'Transcript' })).toBeInTheDocument()
    expect(document.querySelector('.chat-meta .status')).toHaveAttribute('role', 'status')
    expect(document.querySelector('.chat-meta .status')).toHaveTextContent('idle')
  })

  it('flashes "done" for a finished turn but not for a failed one', () => {
    setup({ chat: running([item('u1', 'user_message')]) })
    act(() => useSessionStore.setState({ chat: chatOf([item('u1', 'user_message')], { lastSeq: 5 }) }))
    expect(document.querySelector('.chat-meta .status')).toHaveTextContent('done')
    act(() => useSessionStore.setState({ chat: running([item('u1', 'user_message')], { lastSeq: 6 }) }))
    act(() => useSessionStore.setState({ chat: chatOf([item('u1', 'user_message')], { lastSeq: 7, lastTurnFailed: true }) }))
    // The header says what the transcript shows: the turn failed.
    expect(document.querySelector('.chat-meta .status')).toHaveTextContent('failed')
    expect(document.querySelector('.chat-meta .status')).toHaveClass('status-failed')
  })
})

describe('a removed worktree', () => {
  const worktree = { repo: '/home/me/project', path: '/home/me/.go-chamber/worktrees/project/fix', branch: 'chamber/fix', base: 'abc', removed: true }
  const gone = { ...session, cwd: worktree.path, worktree }

  it('takes no more messages and offers a fork into the repository or the archive', async () => {
    const archiveSession = vi.fn(async () => true)
    setup({ sessions: [gone], archiveSession, chat: chatOf([item('u1', 'user_message')]) })
    expect(screen.queryByRole('combobox', { name: 'Message' })).toBeNull()
    const note = screen.getByRole('group', { name: 'Worktree removed' })
    expect(note).toHaveTextContent('Worktree removed · branch chamber/fix kept in project')
    await userEvent.click(screen.getByRole('button', { name: 'Fork into project' }))
    expect(fns.forkSession).toHaveBeenCalledWith('s1')
    await userEvent.click(screen.getByRole('button', { name: 'Archive' }))
    expect(archiveSession).toHaveBeenCalledWith('s1')
  })

  it('offers no fork before the first turn, and no archive once archived', () => {
    setup({ sessions: [{ ...gone, nativeId: undefined, archivedAt: '2026-10-06T09:00:00Z' }] })
    expect(screen.queryByRole('button', { name: /Fork into/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull()
    expect(screen.queryByText(/Send a message to start/)).toBeNull()
  })

  it('offers no continue for a cut-off turn whose folder is gone', () => {
    const cut = { ...gone, status: 'interrupted' as const, interruption: { reason: 'crashed' } }
    setup({ sessions: [cut], chat: chatOf([item('u1', 'user_message')], { status: 'interrupted' }) })
    expect(screen.queryByRole('button', { name: /Continue/ })).toBeNull()
  })

  it('marks the header: the branch stays, the folder is gone', () => {
    setup({ sessions: [gone] })
    const branch = document.querySelector('.chat-path-line .session-branch')
    expect(branch).toHaveAttribute('data-removed')
    expect(branch).toHaveAttribute('title', 'Worktree removed · branch chamber/fix kept')
  })
})

describe('an archived session', () => {
  it('says so in the header and unarchives from there', async () => {
    const unarchiveSession = vi.fn(async () => true)
    setup({ sessions: [{ ...session, archivedAt: '2026-10-06T09:00:00Z' }], unarchiveSession })
    expect(document.querySelector('.chat-meta .archived-tag')).toHaveTextContent('archived')
    await userEvent.click(screen.getByRole('button', { name: 'Unarchive' }))
    expect(unarchiveSession).toHaveBeenCalledWith('s1')
  })

  it('shows neither for a listed session', () => {
    setup()
    expect(document.querySelector('.archived-tag')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Unarchive' })).toBeNull()
  })
})

describe('header status', () => {
  it('prints the folder short, home as ~, and copies it whole', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    setup()
    const path = document.querySelector('.chat-path')!
    expect(path).toHaveTextContent('~/project')
    expect(path).toHaveAttribute('title', '/home/me/project')
    await userEvent.click(screen.getByRole('button', { name: 'Copy path' }))
    expect(writeText).toHaveBeenCalledWith('/home/me/project')
    expect(useNotices.getState().notices.at(-1)?.text).toBe('Path copied')
  })

  it('reads a worktree session by its repository and branch, and copies the worktree', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const worktree = { repo: '/home/me/project', path: '/home/me/.go-chamber/worktrees/project/fix-readme', branch: 'chamber/fix-readme', base: 'abc' }
    setup({ sessions: [{ ...session, cwd: worktree.path, worktree }] })
    // The repository by its name, as the sessions list groups it: the
    // branch keeps its room.
    expect(document.querySelector('.chat-path')).toHaveTextContent(/^project$/)
    expect(document.querySelector('.chat-path')).toHaveAttribute('title', '/home/me/project')
    const branch = document.querySelector('.chat-path-line .session-branch')!
    expect(branch).toHaveTextContent('fix-readme')
    expect(branch).toHaveAttribute('title', `In a worktree on chamber/fix-readme · ${worktree.path}`)
    await userEvent.click(screen.getByRole('button', { name: 'Copy path' }))
    expect(writeText).toHaveBeenCalledWith(worktree.path)
  })

  const statusEl = () => document.querySelector('.chat-meta .status')

  it('says the session waits for the owner while a request is open, as the list does', () => {
    const request: api.SessionRequest = { id: 'r1', sessionId: 's1', kind: 'permission', state: 'pending', title: 'Run' }
    setup({ chat: running([item('u1', 'user_message')], { requests: { r1: request } }) })
    expect(statusEl()).toHaveTextContent('waiting for you')
    expect(statusEl()).toHaveClass('status-waiting')
  })

  it('still waits for the owner after a restart cut off a turn with a question open', () => {
    const owed = { ...session, status: 'interrupted' as const, interruption: { reason: 'server_restart', withRequest: true } }
    setup({ sessions: [owed], chat: chatOf([item('u1', 'user_message')], { status: 'interrupted' }) })
    expect(statusEl()).toHaveTextContent('waiting for you')
  })

  it('calls a session that never ran idle, not detached', () => {
    setup({ sessions: [{ ...session, status: 'detached', nativeId: undefined }], chat: initialChat() })
    expect(statusEl()).toHaveTextContent('idle')
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

  it('keeps counting a turn that was already running when the page opened', () => {
    vi.useFakeTimers()
    const started = new Date(Date.now() - 42_000).toISOString()
    setup({ sessions: [{ ...session, status: 'running', activeAt: started }], chat: initialChat() })
    expect(screen.getByText('working · 0:42')).toBeInTheDocument()
  })

  it('steps aside while text streams', () => {
    setup({ chat: running([item('a1', 'assistant_message', { status: 'streaming' })]) })
    expect(screen.queryByText(/working ·/)).toBeNull()
  })

  it('says the turn waits for the owner when a request is open', () => {
    const request: api.SessionRequest = { id: 'r1', sessionId: 's1', kind: 'permission', state: 'pending', title: 'Run' }
    setup({ chat: running([item('u1', 'user_message')], { requests: { r1: request } }) })
    expect(document.querySelector('.working-tail')).toHaveTextContent('waiting for you')
    expect(document.querySelector('.working-tail')).toHaveClass('waiting')
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

  it('takes the text out of the composer while it is on its way, and back if it fails', async () => {
    let accept: (ok: boolean) => void = () => {}
    setup()
    fns.send.mockImplementationOnce(() => new Promise<boolean>((r) => (accept = r)))
    await userEvent.type(box(), 'first')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    // Shown once: in the transcript as sending, not also in the box.
    expect(box()).toHaveValue('')
    expect(screen.getByText('sending…')).toBeInTheDocument()
    await act(async () => accept(false))
    expect(box()).toHaveValue('first')
  })

  it('keeps what the owner typed meanwhile when a send fails', async () => {
    let accept: (ok: boolean) => void = () => {}
    setup()
    fns.send.mockImplementationOnce(() => new Promise<boolean>((r) => (accept = r)))
    await userEvent.type(box(), 'first')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    await userEvent.type(box(), 'other')
    await act(async () => accept(false))
    expect(box()).toHaveValue('first\n\nother')
  })

  it('queues messages sent while one is on its way, each on its own, in order', async () => {
    const accepts: ((ok: boolean) => void)[] = []
    setup()
    fns.send.mockImplementation(() => new Promise<boolean>((r) => accepts.push(r)))
    fns.steer.mockImplementation(() => new Promise<boolean>((r) => accepts.push(r)))
    await userEvent.type(box(), 'rapid 1{Enter}')
    await userEvent.type(box(), 'rapid 2{Enter}')
    await userEvent.type(box(), 'rapid 3{Enter}')
    // Nothing is merged or left behind in the box.
    expect(box()).toHaveValue('')
    expect(fns.send).toHaveBeenCalledTimes(1)
    expect(fns.send).toHaveBeenCalledWith('rapid 1', [])
    const rows = () => Array.from(document.querySelectorAll('.row-pending')).map((r) => r.textContent)
    expect(rows()).toEqual(['rapid 1sending…', 'rapid 2queued', 'rapid 3queued'])
    // The button tells what is actually in flight.
    expect(screen.getByRole('button', { name: 'Sending…' })).toBeInTheDocument()
    await act(async () => accepts[0]!(true))
    // The first started a turn: the rest steer it, one after another.
    expect(fns.steer).toHaveBeenCalledTimes(1)
    expect(fns.steer).toHaveBeenLastCalledWith('rapid 2')
    expect(screen.getByRole('button', { name: 'Steering…' })).toBeInTheDocument()
    await act(async () => accepts[1]!(true))
    expect(fns.steer).toHaveBeenLastCalledWith('rapid 3')
    await act(async () => accepts[2]!(true))
    expect(rows()).toEqual(['rapid 1sent', 'rapid 2sent', 'rapid 3sent'])
    expect(fns.send).toHaveBeenCalledTimes(1)
  })

  it('puts a failed message and the ones queued behind it back in the box', async () => {
    const accepts: ((ok: boolean) => void)[] = []
    setup()
    fns.send.mockImplementation(() => new Promise<boolean>((r) => accepts.push(r)))
    await userEvent.type(box(), 'one{Enter}')
    await userEvent.type(box(), 'two{Enter}')
    await act(async () => accepts[0]!(false))
    expect(fns.steer).not.toHaveBeenCalled()
    expect(fns.send).toHaveBeenCalledTimes(1)
    expect(document.querySelectorAll('.row-pending')).toHaveLength(0)
    expect(box()).toHaveValue('one\n\ntwo')
  })

  it('keeps queued messages in the draft when the owner moves to another session', async () => {
    const accepts: ((ok: boolean) => void)[] = []
    setup()
    fns.send.mockImplementation(() => new Promise<boolean>((r) => accepts.push(r)))
    await userEvent.type(box(), 'one{Enter}')
    await userEvent.type(box(), 'two{Enter}')
    act(() => useSessionStore.setState({ activeId: 's2' }))
    await act(async () => accepts[0]!(true))
    expect(fns.steer).not.toHaveBeenCalled()
    expect(fns.send).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem('gc.draft:s1')).toContain('two')
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
    await userEvent.upload(screen.getByLabelText('Attach images'), new File(['x'], 'a.png', { type: 'image/png' }))
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

  it('gives a message of several lines the whole width, the actions beneath', async () => {
    setup()
    const form = () => document.querySelector('form.composer')!
    await userEvent.type(box(), 'one')
    expect(form()).not.toHaveClass('multiline')
    await userEvent.type(box(), '{Shift>}{Enter}{/Shift}two')
    expect(form()).toHaveClass('multiline')
    await userEvent.clear(box())
    expect(form()).not.toHaveClass('multiline')
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

  it('names who reviews approvals in the choice itself', () => {
    setup({ sessions: [{ ...session, agent: 'codex' }] })
    const select = screen.getByLabelText('Approval reviewer')
    expect([...select.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['Default approvals', 'ask me to approve', 'auto-review'])
    expect(select).toHaveAttribute('title', 'Who reviews approvals · default: as the Codex config sets it')
    expect(screen.getByText('Approvals')).toHaveClass('tool-label')
  })

  it('shows the reviewer choice at once and reverts a refused one', async () => {
    let done: (ok: boolean) => void = () => {}
    setup({ sessions: [{ ...session, agent: 'codex', approvalReviewer: 'user' }] })
    fns.setApprovalReviewer.mockImplementationOnce(() => new Promise<boolean>((r) => (done = r)))
    const select = screen.getByLabelText('Approval reviewer')
    await userEvent.selectOptions(select, 'auto_review')
    expect(select).toHaveValue('auto_review')
    expect(select).toHaveAttribute('aria-busy', 'true')
    await act(async () => done(false))
    expect(select).toHaveValue('user')
  })

  it('folds the folder and settings behind a details button', async () => {
    setup()
    const more = screen.getByRole('button', { name: 'Session details' })
    expect(more).toHaveAttribute('aria-expanded', 'false')
    expect(document.getElementById(more.getAttribute('aria-controls')!)).toContainElement(screen.getByLabelText('Permission mode'))
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

  it('after a keyboard answer to the last one, focuses the transcript so the next keys stay shortcuts', async () => {
    pointerFine()
    const respond = vi.fn(async () => true)
    setup({ chat: running([item('u1', 'user_message')], { requests: { r1: permission('r1') } }), respond })
    screen.getByRole('button', { name: 'Allow' }).focus()
    await userEvent.keyboard('{Enter}')
    expect(respond).toHaveBeenCalledWith('s1', 'r1', expect.anything())
    await waitFor(() => expect(document.activeElement).toHaveClass('scroll'))
    expect(box()).not.toHaveFocus()
  })

  it('after a keyboard answer, moves on to the next card', async () => {
    pointerFine()
    const respond = vi.fn(async () => true)
    setup({ chat: running([item('u1', 'user_message')], { requests: { r1: permission('r1'), r2: permission('r2') } }), respond })
    screen.getAllByRole('button', { name: 'Allow' })[0]!.focus()
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(document.activeElement).toHaveAttribute('data-request-id', 'r2'))
  })

  it('on a touch screen brings the next card into view without focusing it', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('pointer: coarse'), media: q, addEventListener: () => {}, removeEventListener: () => {},
    }))
    const respond = vi.fn(async () => true)
    setup({ chat: running([item('u1', 'user_message')], { requests: { r1: permission('r1'), r2: permission('r2') } }), respond })
    const next = document.querySelector<HTMLElement>('[data-request-id="r2"]')!
    vi.mocked(next.scrollIntoView).mockClear()
    await userEvent.click(screen.getAllByRole('button', { name: 'Allow' })[0]!)
    await waitFor(() => expect(next.scrollIntoView).toHaveBeenCalled())
    expect(document.activeElement).not.toBe(next)
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
    expect(screen.getByRole('status', { name: 'Live updates' })).toHaveTextContent(/live updates paused · reconnecting in [45]s/)
    await userEvent.click(screen.getByRole('button', { name: 'Reconnect now' }))
    expect(retryNow).toHaveBeenCalledTimes(1)
  })

  it('says it is reconnecting while a retry is on its way', () => {
    setup({ connection: 'connecting', nextRetryAt: Date.now() - 10 })
    expect(screen.getByRole('status', { name: 'Live updates' })).toHaveTextContent('reconnecting…')
  })

  it('stays quiet while the first connection opens', () => {
    setup({ connection: 'connecting', nextRetryAt: null })
    expect(screen.queryByRole('status', { name: 'Live updates' })).toBeNull()
  })

  it('stops the turn clock: it cannot know the turn still runs', () => {
    setup({ chat: running([item('u1', 'user_message')]), connection: 'offline', nextRetryAt: null })
    expect(screen.queryByText(/working · \d/)).toBeNull()
    expect(screen.getByText('working · paused')).toBeInTheDocument()
  })

  it("marks the header's state unsettled: the page can't see the turn now", () => {
    setup({ chat: running([item('u1', 'user_message')]), connection: 'offline', nextRetryAt: Date.now() + 4000 })
    expect(document.querySelector('.chat-meta .status')).toHaveClass('unsettled')
    expect(document.querySelector('.chat-meta .status')).toHaveAttribute('title', 'May be out of date until the connection is back')
    act(() => useSessionStore.setState({ connection: 'online', nextRetryAt: null }))
    expect(document.querySelector('.chat-meta .status')).not.toHaveClass('unsettled')
  })

  it('holds a message sent while go-chamber is out of reach, and sends it once back', async () => {
    setup({ chat: running([item('u1', 'user_message')]), connection: 'offline', nextRetryAt: Date.now() + 4000 })
    await userEvent.type(box(), 'steer me{Enter}')
    expect(fns.steer).not.toHaveBeenCalled()
    expect(document.querySelector('.row-pending')).toHaveTextContent('steer me')
    expect(document.querySelector('.row-pending .pending-label')).toHaveTextContent('waits for go-chamber')
    await act(async () => useSessionStore.setState({ connection: 'online', nextRetryAt: null }))
    await waitFor(() => expect(fns.steer).toHaveBeenCalledWith('steer me'))
  })

  it('clears a "not sent" notice once go-chamber is back', () => {
    setup({ chat: running([item('u1', 'user_message')]), connection: 'offline', nextRetryAt: Date.now() + 4000 })
    act(() => void notify({ kind: 'error', title: 'Steer not sent', text: 'go-chamber is not reachable', key: 'send' }))
    expect(useNotices.getState().notices).toHaveLength(1)
    act(() => useSessionStore.setState({ connection: 'online', nextRetryAt: null }))
    expect(useNotices.getState().notices).toHaveLength(0)
  })

  it('says it once: the strip tells of the drop, the header keeps quiet', () => {
    const { container } = setup({ chat: running([item('u1', 'user_message')]), connection: 'offline', nextRetryAt: null })
    expect(container.querySelector('.chat-header')).not.toHaveTextContent('offline')
    expect(container.querySelector('.chat-header .health')).toBeNull()
  })
})

describe('usage in the header', () => {
  it('names a turn result for what it is: the last turn', () => {
    setup({ chat: chatOf([], { result: { inputTokens: 10, outputTokens: 20 } }) })
    expect(screen.getByLabelText('Last turn usage')).toHaveTextContent('30 tokens · last turn')
  })

  it('keeps the session total when the agent reports one', () => {
    setup({ chat: chatOf([], { usage: { totalTokens: 1200 }, result: { inputTokens: 1, outputTokens: 2 } }) })
    expect(screen.getByLabelText('Session usage')).toHaveTextContent('1,200 tokens')
  })
})

describe('session not loaded yet', () => {
  it('holds the heading as a placeholder while sessions load', () => {
    setup({ sessions: [], sessionsStatus: 'loading', history: 'loading', chat: initialChat() })
    expect(screen.queryByRole('heading', { name: 'Session' })).toBeNull()
    expect(screen.getByRole('status', { name: 'Loading session' })).toBeInTheDocument()
  })

  it('says so for an unknown session whose empty transcript loaded fine', () => {
    setup({ sessions: [], sessionsStatus: 'ready', history: 'ready', chat: initialChat() })
    expect(screen.getByRole('heading', { name: 'Session not found' })).toBeInTheDocument()
    // A session that isn't there has no state to show.
    expect(document.querySelector('.chat-meta .status')).toBeNull()
    expect(screen.queryByText(/Send a message to start/)).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Message' })).toBeNull()
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

  it('says working while a tool or subagent runs, which shows no words', () => {
    for (const kind of ['command', 'subagent'] as const) {
      const view = setup({ chat: running([item('t1', kind, { status: 'streaming' })]) })
      expect(document.querySelector('.working-tail')).toHaveTextContent('working · 0:00')
      view.unmount()
    }
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

describe('typing on a phone', () => {
  const phone = (coarse = true) =>
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('max-width: 720px') || (coarse && q.includes('pointer: coarse')),
      media: q, addEventListener: () => {}, removeEventListener: () => {},
    }))
  afterEach(() => {
    vi.unstubAllGlobals()
    delete document.documentElement.dataset.typing
  })

  it('marks the page while a chat field has the keyboard, so the chrome can make room', () => {
    phone()
    const { unmount } = setup()
    act(() => box().focus())
    expect(document.documentElement.dataset.typing).toBe('chat')
    act(() => box().blur())
    expect(document.documentElement.dataset.typing).toBeUndefined()
    act(() => box().focus())
    unmount()
    expect(document.documentElement.dataset.typing).toBeUndefined()
  })

  it('keeps the page still under a tap that takes the focus, until the tap is over', () => {
    vi.useFakeTimers()
    phone()
    setup()
    act(() => box().focus())
    act(() => {
      window.dispatchEvent(new Event('pointerdown'))
      box().blur()
    })
    expect(document.documentElement.dataset.typing).toBe('chat')
    act(() => {
      window.dispatchEvent(new Event('pointerup'))
      vi.runOnlyPendingTimers()
    })
    expect(document.documentElement.dataset.typing).toBeUndefined()
  })

  it('keeps the page still under a touch tap, whose focus moves only after the finger lifts, until its click', () => {
    vi.useFakeTimers()
    phone()
    setup()
    act(() => box().focus())
    act(() => {
      window.dispatchEvent(new Event('pointerdown'))
      window.dispatchEvent(new Event('pointerup'))
      vi.advanceTimersByTime(50)
      box().blur()
    })
    expect(document.documentElement.dataset.typing).toBe('chat')
    act(() => {
      window.dispatchEvent(new Event('click'))
      vi.runOnlyPendingTimers()
    })
    expect(document.documentElement.dataset.typing).toBeUndefined()
  })

  it('lets the page grow back after a tap whose click never comes', () => {
    vi.useFakeTimers()
    phone()
    setup()
    act(() => box().focus())
    act(() => {
      window.dispatchEvent(new Event('pointerdown'))
      window.dispatchEvent(new Event('pointerup'))
      box().blur()
    })
    expect(document.documentElement.dataset.typing).toBe('chat')
    act(() => vi.advanceTimersByTime(1000))
    expect(document.documentElement.dataset.typing).toBeUndefined()
  })

  it('lets the keyboard go once a message is sent, so the reply has the screen', async () => {
    phone()
    setup()
    await userEvent.type(box(), 'hello')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(fns.send).toHaveBeenCalled())
    await act(async () => {})
    expect(box()).not.toHaveFocus()
  })

  it('leaves a mouse, or a wide screen, alone', () => {
    phone(false)
    setup()
    act(() => box().focus())
    expect(document.documentElement.dataset.typing).toBeUndefined()
  })

  it("brings a card's field back into view once the keyboard is up", () => {
    vi.useFakeTimers()
    phone()
    const question: api.SessionRequest = {
      id: 'q1', sessionId: 's1', kind: 'question', state: 'pending', title: 'Pick',
      payload: { input: { questions: [{ question: 'Which?', options: [{ label: 'a' }, { label: 'b' }] }] } },
    }
    setup({ chat: running([item('u1', 'user_message')], { requests: { q1: question } }) })
    const card = document.querySelector<HTMLElement>('[data-request-id="q1"]')!
    const field = screen.getByLabelText('Other Which?')
    vi.mocked(card.scrollIntoView).mockClear()
    act(() => field.focus())
    expect(document.documentElement.dataset.typing).toBe('chat')
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(card.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    expect(field.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
  })
})

describe('first message hint', () => {
  it('lists what the composer understands', () => {
    setup()
    expect(document.querySelector('.chat-hint-keys')).toHaveTextContent('@ file · / commands · paste or drop images')
  })

  it('says attach, not drop, on a touch screen', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('pointer: coarse'), media: q, addEventListener: () => {}, removeEventListener: () => {},
    }))
    setup()
    expect(document.querySelector('.chat-hint-keys')).toHaveTextContent('paste or attach images')
    vi.unstubAllGlobals()
  })

  it('names a worktree as its repository and branch, the whole folder on hover', () => {
    const wt: api.Session = {
      ...session, cwd: '/data/worktrees/project/fix-login',
      worktree: { repo: '/home/me/project', path: '/data/worktrees/project/fix-login', branch: 'chamber/fix-login', base: 'abc' },
    }
    setup({ sessions: [wt] })
    const where = document.querySelector('.chat-hint-where')!
    expect(where).toHaveTextContent('The agent runs in project ⎇ fix-login.')
    expect(where.querySelector('[title="/data/worktrees/project/fix-login"]')).not.toBeNull()
  })
})

describe('approval reviewer', () => {
  it('shows a busy mark while saving, like the mode select', async () => {
    setup({ sessions: [{ ...session, agent: 'codex', approvalReviewer: 'user' }] })
    fns.setApprovalReviewer.mockImplementationOnce(() => new Promise<boolean>(() => {}))
    await userEvent.selectOptions(screen.getByLabelText('Approval reviewer'), 'auto_review')
    expect(screen.getByLabelText('Approval reviewer').closest('.reviewer')?.querySelector('.busy-mark')).not.toBeNull()
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
    expect(document.querySelector('.live-strip')).toHaveTextContent('stop sent · waiting for the agent')
    expect(document.querySelector('.composer .composer-note')).toBeNull()
  })

  it('lets go at once when the live connection drops', async () => {
    setup({ chat: running([item('u1', 'user_message')]) })
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(screen.getByRole('button', { name: 'Stopping…' })).toBeInTheDocument()
    act(() => useSessionStore.setState({ connection: 'offline' }))
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
    expect(document.querySelector('.live-strip')).toHaveTextContent('stop sent · waiting for the agent')
    expect(document.querySelector('.composer .composer-note')).toBeNull()
  })
})
