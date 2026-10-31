import { expect, test } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { token } from '../playwright.config'

test('opens the tail, loads older messages on demand and keeps the reading position', async ({ page }, info) => {
  const nativeId = `aaaaaaaa-0000-4000-8000-00000000000${info.project.name === 'desktop' ? 3 : 4}`
  const folder = '.data/claude/projects/-tmp'
  await mkdir(folder, { recursive: true })
  const messages = Array.from({ length: 240 }, (_, i) => JSON.stringify({
    sessionId: nativeId, cwd: '/tmp', isSidechain: false, type: 'assistant', uuid: `p${i}`,
    message: { id: `m${i}`, role: 'assistant', content: [{ type: 'text', text: `History message ${String(i).padStart(3, '0')}` }] },
  }))
  const prompt = JSON.stringify({ sessionId: nativeId, cwd: '/tmp', type: 'user', uuid: 'prompt', message: { role: 'user', content: 'Read this long conversation' } })
  await writeFile(`${folder}/${nativeId}.jsonl`, [prompt, ...messages].join('\n') + '\n')
  const headers = { Authorization: `Bearer ${token}` }
  const imported = await page.request.post('/api/history/import', { headers, data: { agent: 'claude', nativeId } })
  expect(imported.ok(), await imported.text()).toBeTruthy()
  const session = await imported.json() as { id: string }
  const requests: string[] = []
  page.on('request', (request) => { if (request.url().includes(`/sessions/${session.id}/events`)) requests.push(request.url()) })
  await page.goto(`/s/${session.id}?token=${token}`)
  await expect(page.getByText('History message 239', { exact: true })).toBeVisible()
  await expect(page.getByText('History message 000', { exact: true })).toHaveCount(0)
  expect(requests.some((url) => url.includes('limit=200'))).toBeTruthy()
  const scroll = page.locator('.chat > .scroll')
  await scroll.evaluate((el) => { el.scrollTop = 250 })
  const anchor = page.locator('[data-row]').filter({ hasText: 'History message 100' })
  const before = await anchor.boundingBox()
  // This position is above the auto-load threshold: the button is also a
  // keyboard-accessible way to request the preceding page.
  await page.getByRole('button', { name: 'Load older messages' }).evaluate((el: HTMLButtonElement) => el.click())
  await expect(page.getByText('History message 000', { exact: true })).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Load older messages' })).toHaveCount(0)
  const after = await anchor.boundingBox()
  expect(before).not.toBeNull()
  expect(after).not.toBeNull()
  expect(Math.abs(after!.y - before!.y)).toBeLessThan(4)
  expect(requests.some((url) => url.includes('&before='))).toBeTruthy()
  // Reloading starts at the tail again instead of downloading every page.
  await page.reload()
  await expect(page.getByText('History message 239', { exact: true })).toBeVisible()
  await expect(page.getByText('History message 000', { exact: true })).toHaveCount(0)
  await scroll.evaluate((el) => { el.scrollTop = 0 })
  await expect(page.getByText('History message 000', { exact: true })).toHaveCount(1)
})
