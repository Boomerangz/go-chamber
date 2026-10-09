import { expect, test, type APIRequestContext } from '@playwright/test'
import { token } from '../playwright.config'

// connect opens an MCP session over streamable HTTP the way a client
// agent does, and returns a tool caller.
async function connect(request: APIRequestContext) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
  }
  let id = 0
  const rpc = async (method: string, params?: unknown) => {
    const res = await request.post('/api/mcp', { headers, data: { jsonrpc: '2.0', id: ++id, method, params } })
    expect(res.ok()).toBeTruthy()
    const body = await res.text()
    const json = res.headers()['content-type']?.includes('json')
      ? body
      : body.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).pop()!
    return { res, msg: JSON.parse(json) }
  }
  const { res } = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'e2e', version: '1' },
  })
  headers['Mcp-Session-Id'] = res.headers()['mcp-session-id']
  headers['Mcp-Protocol-Version'] = '2025-06-18'
  await request.post('/api/mcp', { headers, data: { jsonrpc: '2.0', method: 'notifications/initialized' } })
  return async (name: string, args: Record<string, unknown>) => {
    const { msg } = await rpc('tools/call', { name, arguments: args })
    return msg.result as { isError?: boolean; structuredContent: Record<string, any>; content: { text: string }[] }
  }
}

test('another agent drives a session over MCP', async ({ page, request }) => {
  const call = await connect(request)

  const started = await call('start_session', { agent: 'claude', cwd: '/tmp', message: 'please permission' })
  expect(started.isError).toBeFalsy()
  const id = started.structuredContent.session.id
  let since = started.structuredContent.since_seq

  const asked = await call('wait', { session_id: id, since_seq: since, timeout_seconds: 20 })
  expect(asked.structuredContent.status).toBe('needs_answer')
  const req = asked.structuredContent.requests[0]
  since = asked.structuredContent.seq

  // Granting is the owner's unless go-chamber runs with -mcp-allow-approvals.
  const grant = await call('answer_request', { session_id: id, request_id: req.id, allow: true })
  expect(grant.isError).toBeTruthy()
  expect(grant.content[0].text).toContain('mcp-allow-approvals')

  const deny = await call('answer_request', { session_id: id, request_id: req.id, allow: false, message: 'not from here' })
  expect(deny.isError).toBeFalsy()
  const done = await call('wait', { session_id: id, since_seq: since, timeout_seconds: 20 })
  expect(done.structuredContent.status).toBe('idle')
  expect(done.structuredContent.final).toContain('denied: not from here')

  // The owner sees who wrote and who decided.
  await page.goto(`/s/${id}?token=${token}`)
  await expect(page.locator('.item.user', { hasText: 'please permission' }).locator('.origin-tag')).toHaveText('via MCP')
  await expect(page.locator('.decision .origin-tag')).toHaveText('via MCP')
})
