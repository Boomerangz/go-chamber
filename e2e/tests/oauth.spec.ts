import { createHash, randomBytes } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { token } from '../playwright.config'

const redirect = 'https://chatgpt.com/connector_platform_oauth_redirect'

test('the owner links an OAuth client, whose token opens MCP and nothing else', async ({ page, request, baseURL }) => {
  const resource = `${baseURL}/api/mcp`
  const reg = await request.post('/oauth/register', { data: { client_name: 'ChatGPT', redirect_uris: [redirect] } })
  expect(reg.status()).toBe(201)
  const clientId = (await reg.json()).client_id

  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const query = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: redirect, code_challenge: challenge,
    code_challenge_method: 'S256', state: 'st8', resource, scope: 'mcp',
  })

  // The approval is sent for real; where it sends the browser is only
  // read, so the test never leaves for the client.
  let landed = ''
  await page.route('**/oauth/authorize', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    const answer = await route.fetch({ maxRedirects: 0 })
    landed = answer.headers()['location'] ?? ''
    await route.fulfill({ status: 200, body: 'linked' })
  })
  await page.goto(`/?token=${token}`)
  await page.goto(`/oauth/authorize?${query}`)
  await expect(page.getByText('asks to drive your agent sessions')).toBeVisible()
  await page.getByRole('button', { name: 'Allow' }).click()
  await expect.poll(() => landed).toContain(redirect)
  const back = new URL(landed)
  expect(back.searchParams.get('state')).toBe('st8')

  const tok = await request.post('/oauth/token', {
    form: { grant_type: 'authorization_code', code: back.searchParams.get('code')!, redirect_uri: redirect, client_id: clientId, code_verifier: verifier, resource },
  })
  expect(tok.ok()).toBeTruthy()
  const access = (await tok.json()).access_token

  const mcp = await request.post('/api/mcp', {
    headers: { Authorization: `Bearer ${access}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
    data: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } },
  })
  expect(mcp.status()).toBe(200)
  const sessions = await request.get('/api/sessions', { headers: { Authorization: `Bearer ${access}` } })
  expect(sessions.status()).toBe(401)
})
