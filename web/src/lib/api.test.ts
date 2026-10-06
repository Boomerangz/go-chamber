import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createSession,
  fetchEvents,
  fetchHealth,
  getAccount,
  getQuotas,
  getSession,
  interrupt,
  listRequests,
  listSessions,
  refreshQuota,
  respondRequest,
  sendMessage,
  startLogin,
  steer,
  stopTask,
  setApprovalReviewer,
  listFolders,
  searchMessages,
  listModels,
  setModel,
  UNAUTHORIZED_EVENT,
} from './api'

afterEach(() => vi.unstubAllGlobals())

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl)
  vi.stubGlobal('fetch', fn)
  return fn
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('fetchHealth', () => {
  it('returns online when server answers ok', async () => {
    const fn = stubFetch(async () => json({ status: 'ok' }))
    expect(await fetchHealth()).toBe('online')
    expect(fn).toHaveBeenCalledWith('/api/health', { credentials: 'same-origin' })
  })

  it('returns unauthorized on 401', async () => {
    stubFetch(async () => new Response('', { status: 401 }))
    expect(await fetchHealth()).toBe('unauthorized')
  })

  it('returns offline on other statuses', async () => {
    stubFetch(async () => new Response('', { status: 500 }))
    expect(await fetchHealth()).toBe('offline')
  })

  it('returns offline when body is not ok', async () => {
    stubFetch(async () => json({ status: 'degraded' }))
    expect(await fetchHealth()).toBe('offline')
  })

  it('returns offline on network error', async () => {
    stubFetch(async () => {
      throw new TypeError('network')
    })
    expect(await fetchHealth()).toBe('offline')
  })
})

describe('session API', () => {
  it('announces an expired login when the API answers 401', async () => {
    stubFetch(async () => new Response('unauthorized', { status: 401 }))
    const seen = vi.fn()
    window.addEventListener(UNAUTHORIZED_EVENT, seen)
    await expect(listSessions()).rejects.toThrow('Signed out')
    window.removeEventListener(UNAUTHORIZED_EVENT, seen)
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('lists sessions', async () => {
    const fn = stubFetch(async () => json([{ id: 'a' }]))
    expect(await listSessions()).toEqual([{ id: 'a' }])
    expect(fn).toHaveBeenCalledWith('/api/sessions', { credentials: 'same-origin' })
  })

  it('creates a session with a JSON body', async () => {
    const fn = stubFetch(async () => json({ id: 'new' }, 201))
    await createSession('claude', '/tmp/x')
    const [url, init] = fn.mock.calls[0]!
    expect(url).toBe('/api/sessions')
    expect(init).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } })
    expect(JSON.parse(String(init?.body))).toEqual({ agent: 'claude', cwd: '/tmp/x' })
  })

  it('gets a session by id', async () => {
    const fn = stubFetch(async () => json({ id: 'a b' }))
    await getSession('a b')
    expect(fn.mock.calls[0]![0]).toBe('/api/sessions/a%20b')
  })

  it('sends a message and tolerates an empty response', async () => {
    const fn = stubFetch(async () => new Response('', { status: 202 }))
    await expect(sendMessage('a', 'hi')).resolves.toBeUndefined()
    expect(JSON.parse(String(fn.mock.calls[0]![1]?.body))).toEqual({ text: 'hi' })
  })

  it('interrupts a session', async () => {
    const fn = stubFetch(async () => new Response('', { status: 202 }))
    await interrupt('a')
    expect(fn.mock.calls[0]![1]).toMatchObject({ method: 'POST' })
  })

  it('fetches events since a sequence', async () => {
    const fn = stubFetch(async () => json([{ seq: 2 }]))
    expect(await fetchEvents('a', 1)).toEqual([{ seq: 2 }])
    expect(fn.mock.calls[0]![0]).toBe('/api/sessions/a/events?since=1')
  })

  it('throws with the server message on errors', async () => {
    stubFetch(async () => new Response('nope', { status: 500 }))
    await expect(listSessions()).rejects.toThrow('nope')
  })

  it('falls back to the status text on empty error bodies', async () => {
    stubFetch(async () => new Response('', { status: 500, statusText: 'oops' }))
    await expect(listSessions()).rejects.toThrow('500 oops')
  })
})

describe('request API', () => {
  it('lists pending requests', async () => {
    const fn = stubFetch(async () => json([{ id: 'r1' }]))
    expect(await listRequests()).toEqual([{ id: 'r1' }])
    expect(fn.mock.calls[0]![0]).toBe('/api/requests')
  })

  it('posts an answer to a request', async () => {
    const fn = stubFetch(async () => new Response('', { status: 202 }))
    await respondRequest('s a', 'r 1', { behavior: 'allow', allowForSession: true })
    expect(fn.mock.calls[0]![0]).toBe('/api/sessions/s%20a/requests/r%201')
    expect(JSON.parse(String(fn.mock.calls[0]![1]?.body))).toEqual({ behavior: 'allow', allowForSession: true })
  })
})

describe('account API', () => {
  it('gets the codex account', async () => {
    const fn = stubFetch(async () => json({ agent: 'codex', loggedIn: true }))
    expect(await getAccount('codex')).toEqual({ agent: 'codex', loggedIn: true })
    expect(fn.mock.calls[0]![0]).toBe('/api/account?agent=codex')
  })

  it('starts a login', async () => {
    const fn = stubFetch(async () => json({ userCode: 'CODE', url: 'https://x' }))
    await startLogin('codex')
    expect(fn.mock.calls[0]![0]).toBe('/api/agents/codex/login')
    expect(fn.mock.calls[0]![1]).toMatchObject({ method: 'POST' })
  })
})

describe('steer API', () => {
  it('posts steer text', async () => {
    const fn = stubFetch(async () => new Response('', { status: 202 }))
    await steer('a', 'more')
    expect(fn.mock.calls[0]![0]).toBe('/api/sessions/a/steer')
    expect(JSON.parse(String(fn.mock.calls[0]![1]?.body))).toEqual({ text: 'more' })
  })
})

describe('stopTask API', () => {
  it('posts to the task stop endpoint', async () => {
    const fn = stubFetch(async () => new Response('', { status: 202 }))
    await stopTask('s a', 'task 1')
    expect(fn.mock.calls[0]![0]).toBe('/api/sessions/s%20a/tasks/task%201/stop')
  })
})

describe('quota API', () => {
  it('lists quotas', async () => {
    const fn = stubFetch(async () => json([{ agent: 'codex' }]))
    expect(await getQuotas()).toEqual([{ agent: 'codex' }])
    expect(fn.mock.calls[0]![0]).toBe('/api/quotas')
  })

  it('refreshes a quota', async () => {
    const fn = stubFetch(async () => json({ agent: 'codex' }))
    await refreshQuota('codex')
    expect(fn.mock.calls[0]![0]).toBe('/api/quotas/codex/refresh')
  })
})

describe('setApprovalReviewer API', () => {
  it('posts the reviewer and returns the session', async () => {
    const fn = stubFetch(async () => json({ id: 's a', approvalReviewer: 'auto_review' }))
    const session = await setApprovalReviewer('s a', 'auto_review')
    expect(session.approvalReviewer).toBe('auto_review')
    const [url, init] = fn.mock.calls[0]
    expect(url).toBe('/api/sessions/s%20a/approval-reviewer')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ reviewer: 'auto_review' })
  })
})

describe('listFolders API', () => {
  it('asks for a path and hidden folders', async () => {
    const fn = stubFetch(async () => json({ path: '/a b', home: '/h', folders: [] }))
    const listing = await listFolders('/a b', true)
    expect(listing.path).toBe('/a b')
    expect(fn.mock.calls[0][0]).toBe('/api/folders?path=%2Fa+b&hidden=1')
  })

  it('defaults to home without hidden folders', async () => {
    const fn = stubFetch(async () => json({ path: '/h', home: '/h', folders: [] }))
    await listFolders()
    expect(fn.mock.calls[0][0]).toBe('/api/folders')
  })
})

describe('searchMessages API', () => {
  it('encodes the query', async () => {
    const fn = stubFetch(async () => json([{ sessionId: 's', itemId: 'i', snippet: '[[a]]', matches: 1 }]))
    const hits = await searchMessages('a b&c')
    expect(hits[0].sessionId).toBe('s')
    expect(fn.mock.calls[0][0]).toBe('/api/search?q=a+b%26c')
  })
})

describe('model API', () => {
  it('lists models and sets a session model', async () => {
    const fn = stubFetch(async () => json([{ id: 'opus', name: 'Opus' }]))
    expect((await listModels('claude'))[0].id).toBe('opus')
    expect(fn.mock.calls[0][0]).toBe('/api/agents/claude/models')
    const set = stubFetch(async () => json({ id: 's a', model: 'opus', effort: 'high' }))
    expect((await setModel('s a', { model: 'opus', effort: 'high' })).effort).toBe('high')
    expect(set.mock.calls[0][0]).toBe('/api/sessions/s%20a/model')
    expect(JSON.parse(String(set.mock.calls[0][1]?.body))).toEqual({ model: 'opus', effort: 'high' })
  })

  it('creates a session with a model choice', async () => {
    const fn = stubFetch(async () => json({ id: 'n' }))
    await createSession('codex', '/p', { model: 'gpt', effort: '' })
    expect(JSON.parse(String(fn.mock.calls[0][1]?.body))).toEqual({ agent: 'codex', cwd: '/p', model: 'gpt', effort: '' })
  })
})
