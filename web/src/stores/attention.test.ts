import { beforeEach, expect, it, vi } from 'vitest'
import { useAttention, elapsed, brief, actionLabel } from './attention'
import type { SessionEvent } from '../lib/api'
import * as api from '../lib/api'

vi.mock('../lib/api', () => ({ fetchEvents: vi.fn() }))
const send = (ev: Partial<SessionEvent>, at?: number) => useAttention.getState().ingest({ sessionId: 's', seq: 1, type: 'turn.started', ...ev }, at)
beforeEach(() => { useAttention.getState().reset(); vi.clearAllMocks() })

it('tracks background turns, actions, waiting and a frozen result', () => {
  send({}, 1000)
  send({ seq: 2, type: 'item.updated', item: { id: 'u', sessionId: 's', kind: 'user_message', status: 'completed', text: 'Fix session recovery' } }, 2000)
  send({ seq: 3, type: 'item.updated', item: { id: 't', sessionId: 's', kind: 'command', status: 'streaming', text: 'make test' } }, 3000)
  send({ seq: 4, type: 'request.opened', request: { id: 'r', sessionId: 's', kind: 'permission', state: 'pending' } }, 4000)
  expect(useAttention.getState().entries.s).toMatchObject({ startedAt: 1000, summary: 'Fix session recovery', waiting: { r: 4000 }, actions: { t: { label: 'Running make test', since: 3000 } } })
  send({ seq: 5, type: 'request.resolved', request: { id: 'r', sessionId: 's', kind: 'permission', state: 'resolved' } }, 5000)
  send({ seq: 6, type: 'turn.ended', result: { text: 'Fixed recovery. Tests passed.' } }, 61000)
  const e = useAttention.getState().entries.s!
  expect(e).toMatchObject({ endedAt: 61000, outcome: 'Done', result: 'Fixed recovery. Tests passed.', actions: {}, waiting: {} })
  expect(elapsed(e.startedAt, e.endedAt!)).toBe('1:00')
  send({ seq: 3, type: 'turn.started' }, 70000)
  expect(useAttention.getState().entries.s).toBe(e)
  useAttention.getState().dismiss('s')
  expect(useAttention.getState().entries.s?.dismissed).toBe(true)
  send({ seq: 7 }, 80000)
  expect(useAttention.getState().entries.s).toMatchObject({ startedAt: 80000, dismissed: false, result: '', actions: {} })
})

it('restores actions without inventing historical durations and keeps concurrent live events', async () => {
  let finish!: (events: SessionEvent[]) => void
  vi.mocked(api.fetchEvents).mockReturnValue(new Promise((r) => { finish = r }))
  const refresh = useAttention.getState().refresh([{ id: 's', agent: 'claude', cwd: '/p', status: 'running', activeAt: '2026-10-07T00:00:00Z' }])
  send({ seq: 3, type: 'turn.ended', result: { isError: true, error: 'Oops' } }, 10000)
  finish([{ sessionId: 's', seq: 1, type: 'turn.started' }, { sessionId: 's', seq: 2, type: 'item.updated', item: { id: 't', sessionId: 's', kind: 'command', status: 'streaming', text: 'npm test' } }])
  await refresh
  expect(useAttention.getState().entries.s).toMatchObject({ outcome: 'Failed', result: 'Oops', actions: {} })
  expect(useAttention.getState().entries.s?.startedAt).toBe(Date.parse('2026-10-07T00:00:00Z'))
})

it('handles parallel tools, completion, failed commands, and deletion', () => {
  send({}, 100)
  const item = { id: 'a', sessionId: 's', kind: 'tool_call' as const, name: 'Read', input: { file_path: '/p/session.ts' }, status: 'streaming' as const }
  send({ seq: 2, type: 'item.updated', item }, 200)
  send({ seq: 3, type: 'item.updated', item: { ...item, id: 'b' } }, 300)
  send({ seq: 4, type: 'item.updated', item: { ...item, status: 'completed' } }, 400)
  expect(Object.keys(useAttention.getState().entries.s!.actions)).toEqual(['b'])
  send({ seq: 5, type: 'item.updated', item: { ...item, id: 'b', status: 'failed' } }, 500)
  expect(useAttention.getState().entries.s!.activity).toBe('Failed: Reading session.ts')
  send({ seq: 6, type: 'session.removed' }, 600)
  expect(useAttention.getState().entries.s).toBeUndefined()
})

it.each([
  [{ stopped: true }, 'Stopped'],
  [{ interruptionReason: 'crashed' }, 'Interrupted'],
  [{ isError: true }, 'Failed'],
  [{}, 'Done'],
])('distinguishes turn outcomes %j', (result, outcome) => {
  send({ type: 'turn.ended', result }, 1000)
  expect(useAttention.getState().entries.s?.outcome).toBe(outcome)
})

it('keeps labels short and clocks honest', () => {
  expect(brief('  **Fix**\n the `session` recovery  ')).toBe('Fix the session recovery')
  expect(brief('one two three four five six seven eight nine', 8)).toBe('one two three four five six seven eight…')
  expect(elapsed(undefined, 1000)).toBe('—')
  expect(elapsed(5000, 1000)).toBe('0:00')
  expect(elapsed(0, 3661000)).toBe('1:01:01')
  expect(actionLabel({ id: 'a', sessionId: 's', kind: 'file_change', status: 'streaming', path: '/p/a.ts' })).toBe('Editing a.ts')
})

it('does not rerender the panel for token deltas', () => {
  send({}, 1000)
  const entries = useAttention.getState().entries
  send({ seq: 2, type: 'text.delta', delta: { itemId: 'a', text: 'hello' } }, 2000)
  expect(useAttention.getState().entries).toBe(entries)
})

it('preserves action start on updates and removes only the resolved request', () => {
  const item = { id: 't', sessionId: 's', kind: 'command' as const, status: 'pending' as const, text: 'test' }
  send({ type: 'item.updated', item }, 1000)
  send({ seq: 2, type: 'item.updated', item: { ...item, status: 'streaming' } }, 2000)
  expect(useAttention.getState().entries.s!.actions.t?.since).toBe(1000)
  const request = { id: 'a', sessionId: 's', kind: 'question' as const, state: 'pending' as const }
  send({ seq: 3, type: 'request.opened', request }, 3000)
  send({ seq: 4, type: 'request.opened', request: { ...request, id: 'b' } }, 4000)
  send({ seq: 5, type: 'request.resolved', request }, 5000)
  expect(useAttention.getState().entries.s!.waiting).toEqual({ b: 4000 })
})

it('uses the server task start and keeps restored durations unknown', async () => {
  vi.mocked(api.fetchEvents).mockResolvedValue([
    { sessionId: 's', seq: 1, type: 'turn.started', session: { id: 's', agent: 'codex', cwd: '/p', status: 'running', activeAt: '2026-10-07T00:00:00Z' } },
    { sessionId: 's', seq: 2, type: 'item.updated', item: { id: 'r', sessionId: 's', kind: 'tool_call', status: 'pending', name: 'Read', input: { path: '/p/a' } } },
    { sessionId: 's', seq: 3, type: 'request.opened', request: { id: 'q', sessionId: 's', kind: 'permission', state: 'pending' } },
  ])
  await useAttention.getState().refresh([{ id: 's', agent: 'codex', cwd: '/p', status: 'running', activeAt: 'invalid' }])
  const e = useAttention.getState().entries.s!
  expect(e.startedAt).toBe(Date.parse('2026-10-07T00:00:00Z'))
  expect(e.actions.r).toEqual({ label: 'Reading a', since: undefined })
  expect(e.waiting).toEqual({ q: undefined })
  expect(api.fetchEvents).toHaveBeenCalledWith('s', 0)
  send({ seq: 4, type: 'item.updated', item: { id: 'r', sessionId: 's', kind: 'tool_call', status: 'streaming', name: 'Read', input: { path: '/p/a' } } }, 9000)
  expect(useAttention.getState().entries.s!.actions.r?.since).toBeUndefined()
})

it('marks a failed refresh and clears it on retry without forgetting dismissal', async () => {
  send({ seq: 2, type: 'turn.ended', result: { text: 'Complete' } }, 100)
  useAttention.getState().dismiss('s')
  const sessions = [{ id: 's', agent: 'codex' as const, cwd: '/p', status: 'idle' as const, endedAt: '2026-10-07T00:00:00Z' }]
  vi.mocked(api.fetchEvents).mockRejectedValueOnce(new Error('offline')).mockResolvedValue([])
  await useAttention.getState().refresh(sessions)
  expect(useAttention.getState().entries.s).toMatchObject({ historyError: 'offline', result: 'Complete', dismissed: true })
  await useAttention.getState().refresh(sessions)
  expect(useAttention.getState().entries.s?.historyError).toBeUndefined()
  expect(api.fetchEvents).toHaveBeenLastCalledWith('s', 0)
})

it('ignores idle history and children, and cancels an old refresh after reset', async () => {
  const session = { id: 's', agent: 'claude' as const, cwd: '/p', status: 'running' as const }
  await useAttention.getState().refresh([{ ...session, status: 'idle' }, { ...session, parentId: 'parent' }])
  expect(api.fetchEvents).not.toHaveBeenCalled()
  let finish!: (events: SessionEvent[]) => void
  vi.mocked(api.fetchEvents).mockReturnValue(new Promise((r) => { finish = r }))
  const pending = useAttention.getState().refresh([session, { ...session, id: 'later' }])
  await useAttention.getState().refresh([session])
  expect(api.fetchEvents).toHaveBeenCalledTimes(1)
  useAttention.getState().reset()
  finish([{ sessionId: 's', seq: 1, type: 'turn.started' }])
  await pending
  expect(useAttention.getState().entries).toEqual({})
  expect(api.fetchEvents).toHaveBeenCalledTimes(1)
})

it.each([
  ['Bash', { command: 'npm test' }, 'Running npm test'],
  ['exec_command', { cmd: 'pwd' }, 'Running pwd'],
  ['Edit', { file_path: '/x/a.ts' }, 'Editing a.ts'],
  ['Write', { path: '/x/b.ts' }, 'Editing b.ts'],
  ['Grep', { pattern: 'session' }, 'Searching session'],
  ['search', { query: 'timer' }, 'Searching timer'],
  ['Glob', {}, 'Searching project'],
  ['custom_tool', {}, 'Using custom_tool'],
] as const)('describes %s', (name, input, label) => {
  expect(actionLabel({ id: 't', sessionId: 's', kind: 'tool_call', status: 'streaming', name, input })).toBe(label)
})

it('does not let an assistant reply hide an active command', () => {
  send({ type: 'item.updated', item: { id: 't', sessionId: 's', kind: 'command', status: 'streaming', text: 'test' } }, 100)
  send({ seq: 2, type: 'item.updated', item: { id: 'a', sessionId: 's', kind: 'assistant_message', status: 'streaming' } }, 200)
  expect(useAttention.getState().entries.s?.activity).toBe('Working')
  send({ seq: 3, type: 'item.updated', item: { id: 't', sessionId: 's', kind: 'command', status: 'completed' } }, 300)
  send({ seq: 4, type: 'item.updated', item: { id: 'a', sessionId: 's', kind: 'assistant_message', status: 'streaming' } }, 400)
  expect(useAttention.getState().entries.s?.activity).toBe('Writing a reply')
})

it('keeps dismissal during a refresh and does not resurrect a deleted session on failure', async () => {
  const session = { id: 's', agent: 'claude' as const, cwd: '/p', status: 'idle' as const, endedAt: '2026-10-07T00:00:00Z' }
  send({ seq: 2, type: 'turn.ended', result: { text: 'Done' } }, 100)
  let finish!: (events: SessionEvent[]) => void
  vi.mocked(api.fetchEvents).mockReturnValueOnce(new Promise((r) => { finish = r }))
  const pending = useAttention.getState().refresh([session])
  useAttention.getState().dismiss('s')
  finish([])
  await pending
  expect(useAttention.getState().entries.s?.dismissed).toBe(true)
  let reject!: (error: Error) => void
  vi.mocked(api.fetchEvents).mockReturnValueOnce(new Promise((_, r) => { reject = r }))
  const failed = useAttention.getState().refresh([session], { catchUp: true })
  send({ seq: 3, type: 'session.removed' }, 200)
  reject(new Error('gone'))
  await failed
  expect(useAttention.getState().entries.s).toBeUndefined()
})

it('recovers a missed turn ending even after a newer session state arrived', async () => {
  const session = { id: 's', agent: 'claude' as const, cwd: '/p', status: 'idle' as const, endedAt: '2026-10-07T00:00:00Z' }
  send({}, 1000)
  send({ seq: 4, type: 'session.state', session }, 5000)
  vi.mocked(api.fetchEvents).mockResolvedValue([
    { sessionId: 's', seq: 1, type: 'turn.started' },
    { sessionId: 's', seq: 2, type: 'item.updated', item: { id: 'u', sessionId: 's', kind: 'user_message', status: 'completed', text: 'Fix recovery' } },
    { sessionId: 's', seq: 3, type: 'turn.ended', result: { text: 'Recovered result' } },
    { sessionId: 's', seq: 4, type: 'session.state', session },
  ])
  await useAttention.getState().refresh([session])
  expect(useAttention.getState().entries.s).toMatchObject({ outcome: 'Done', result: 'Recovered result', summary: 'Fix recovery', startedAt: 1000 })
  expect(useAttention.getState().entries.s?.endedAt).toBeUndefined()
})

const running = { id: 's', agent: 'claude' as const, cwd: '/p', status: 'running' as const }
const ev = (seq: number, type: SessionEvent['type'] = 'session.state'): SessionEvent => ({ sessionId: 's', seq, type })

it('follows a session born while listening without fetching its transcript', async () => {
  send({}, 1000)
  send({ seq: 2, type: 'item.updated', item: { id: 'u', sessionId: 's', kind: 'user_message', status: 'completed', text: 'Born live' } }, 1100)
  await useAttention.getState().refresh([running])
  expect(api.fetchEvents).not.toHaveBeenCalled()
  expect(useAttention.getState().entries.s?.summary).toBe('Born live')
})

it('fetches a session once, then follows it live and catches up only after its last seq', async () => {
  vi.mocked(api.fetchEvents).mockResolvedValue([ev(1, 'turn.started'), ev(2)])
  await useAttention.getState().refresh([running])
  await useAttention.getState().refresh([{ ...running, activeAt: 'later' }])
  expect(api.fetchEvents).toHaveBeenCalledTimes(1)
  expect(api.fetchEvents).toHaveBeenCalledWith('s', 0)
  send({ seq: 3, type: 'item.updated', item: { id: 't', sessionId: 's', kind: 'command', status: 'streaming', text: 'make' } }, 3000)
  vi.mocked(api.fetchEvents).mockResolvedValue([{ sessionId: 's', seq: 4, type: 'turn.ended', result: { text: 'All done' } }])
  await useAttention.getState().refresh([running], { catchUp: true })
  expect(api.fetchEvents).toHaveBeenLastCalledWith('s', 3)
  expect(useAttention.getState().entries.s).toMatchObject({ outcome: 'Done', result: 'All done', actions: {} })
})

it('rebuilds a session whose live events skipped a seq', async () => {
  send({}, 1000)
  send({ seq: 5, type: 'turn.ended', result: { text: 'Late' } }, 5000)
  vi.mocked(api.fetchEvents).mockResolvedValue([ev(1, 'turn.started'), { sessionId: 's', seq: 5, type: 'turn.ended', result: { text: 'Late' } }])
  await useAttention.getState().refresh([running])
  expect(api.fetchEvents).toHaveBeenCalledWith('s', 0)
  await useAttention.getState().refresh([running])
  expect(api.fetchEvents).toHaveBeenCalledTimes(1)
})

it('follows the results the owner has not seen, not the ones they have', async () => {
  vi.mocked(api.fetchEvents).mockResolvedValue([])
  const ended = { ...running, status: 'idle' as const, endedAt: '2026-10-07T00:01:00Z' }
  await useAttention.getState().refresh([
    { ...ended, id: 'seen', seen: { at: '2026-10-07T00:02:00Z' } },
    { ...ended, id: 'news', seen: { at: '2026-10-07T00:00:00Z' } },
  ])
  expect(api.fetchEvents).toHaveBeenCalledTimes(1)
  expect(api.fetchEvents).toHaveBeenCalledWith('news', 0)
})

it("times a wait from the request's own opening", () => {
  send({ type: 'request.opened', request: { id: 'r', sessionId: 's', kind: 'question', state: 'pending', openedAt: new Date(4000).toISOString() } }, 9000)
  expect(useAttention.getState().entries.s?.waiting).toEqual({ r: 4000 })
})

it('names a subagent by its task, not its tool', () => {
  expect(actionLabel({ id: 'a', sessionId: 's', kind: 'subagent', status: 'streaming', name: 'Task', input: { description: 'Explore the repo' } })).toBe('Subagent: Explore the repo')
  expect(actionLabel({ id: 'a', sessionId: 's', kind: 'subagent', status: 'streaming', name: 'Task', text: 'Find tests' })).toBe('Subagent: Find tests')
})

it('restores a dismissed result', () => {
  send({ type: 'turn.ended', result: { text: 'Done' } }, 100)
  useAttention.getState().dismiss('s')
  useAttention.getState().undismiss('s')
  expect(useAttention.getState().entries.s?.dismissed).toBe(false)
})
