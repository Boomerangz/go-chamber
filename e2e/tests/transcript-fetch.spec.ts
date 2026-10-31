import { expect, test, type Page } from '@playwright/test'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { token } from '../playwright.config'
import { showPane } from './pane'

const headers = { Authorization: `Bearer ${token}` }

async function sessionWith(page: Page, text: string): Promise<string> {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), 'gc-fetch-')))
  const { id } = (await (await page.request.post('/api/sessions', { headers, data: { agent: 'claude', cwd } })).json()) as { id: string }
  await page.request.post(`/api/sessions/${id}/messages`, { headers, data: { text } })
  return id
}

// Opening downloads one tail page, shared with the socket's catch-up. A
// revisit keeps that page and asks only for events beyond its checkpoint.
test('a chat downloads its transcript once and a revisit renders from memory', async ({ page }) => {
  const a = await sessionWith(page, 'hello fetch A')
  const b = await sessionWith(page, 'hello fetch B')
  const since: Record<string, string[]> = { [a]: [], [b]: [] }
  page.on('request', (req) => {
    const url = new URL(req.url())
    const m = /\/api\/sessions\/([^/]+)\/events$/.exec(url.pathname)
    if (m && since[m[1]!]) since[m[1]!]!.push(url.searchParams.has('limit') ? 'tail' : url.searchParams.get('since')!)
  })
  await page.goto(`/s/${a}?token=${token}`)
  await expect(page.getByText('echo: hello fetch A')).toBeVisible()
  await expect(page.getByRole('status', { name: 'online' })).toBeVisible()
  await expect.poll(() => since[a]!.length).toBeGreaterThan(0)
  // Give the socket's catch-up time to (wrongly) download it again.
  await page.waitForTimeout(500)
  expect(since[a]!.filter((s) => s === 'tail')).toHaveLength(1)
  expect(since[a]!.filter((s) => s === '0')).toHaveLength(0)

  await showPane(page, 'Sessions')
  await page.locator(`button[data-session="${b}"]`).click()
  await expect(page.getByText('echo: hello fetch B')).toBeVisible()
  await showPane(page, 'Sessions')
  await page.locator(`button[data-session="${a}"]`).click()
  // From memory: shown before any download could answer.
  await expect(page.getByText('echo: hello fetch A')).toBeVisible({ timeout: 300 })
  await page.waitForTimeout(500)
  expect(since[a]!.filter((s) => s === 'tail')).toHaveLength(1)
  expect(since[a]!.length).toBeGreaterThan(1)
})
