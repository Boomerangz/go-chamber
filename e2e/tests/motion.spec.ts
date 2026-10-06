import fs from 'node:fs'
import os from 'node:os'
import { expect, test } from '@playwright/test'
import { token } from '../playwright.config'
import { openNewSession } from './pane'

test.use({ reducedMotion: 'reduce' })

// ownDir is a fresh folder of the test's own: the shared /tmp group holds
// every other spec's sessions, which push a row under "Show N older".
const ownDir = () => fs.realpathSync(fs.mkdtempSync(`${os.tmpdir()}/gc-motion-`))

test('works without motion: items appear and an answered request leaves', async ({ page }, info) => {
  const text = `still ${info.project.name}: please permission`
  await page.goto(`/?token=${token}`)
  await openNewSession(page)
  await page.getByLabel('Working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByLabel('Message')).toBeVisible()

  await page.getByLabel('Message').fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByLabel('Turn 1')).toBeVisible()
  await expect(page.locator('.request-title', { hasText: 'Run command' })).toBeVisible()

  await page.getByRole('button', { name: 'Allow', exact: true }).click()
  await expect(page.locator('.item.assistant', { hasText: /approved: run/ })).toBeVisible()
  await expect(page.locator('.request')).toHaveCount(0)
  await expect(page.locator('.item.decision', { hasText: 'Run command' })).toContainText('approved')

  // The record outlives a reload: it is part of the session's transcript.
  await page.reload()
  await showSessions(page)
  await page.locator('.session', { hasText: text }).click()
  await expect(page.locator('.item.decision', { hasText: 'Run command' })).toContainText('approved')
})

test('marks what arrived since the session was last open', async ({ page }, info) => {
  const text = `unseen ${info.project.name}: please permission`
  await page.goto(`/?token=${token}`)
  const open = async (dir: string) => {
    await showSessions(page)
    await openNewSession(page)
    await page.getByLabel('Working directory').fill(dir)
    await page.getByRole('button', { name: 'New session', exact: true }).click()
    await expect(page.locator('.chat-hint')).toBeVisible()
  }
  await open(ownDir())
  await page.getByLabel('Message').fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.request-title', { hasText: 'Run command' })).toBeVisible()
  await expect(page.locator('.unseen-mark')).toHaveCount(0)

  // Away in another session, the request is answered elsewhere and the
  // first session moves on.
  await open('/usr')
  const sessions: { id: string; title?: string }[] = await (await page.request.get('/api/sessions')).json()
  const own = sessions.find((s) => s.title?.includes(text))
  const requests: { id: string; sessionId: string }[] = await (await page.request.get('/api/requests')).json()
  const pending = requests.find((r) => r.sessionId === own?.id)!
  const answered = await page.request.post(`/api/sessions/${pending.sessionId}/requests/${pending.id}`, {
    data: { behavior: 'allow' },
  })
  expect(answered.ok()).toBe(true)

  await showSessions(page)
  await page.locator('.session', { hasText: text }).click()
  await expect(page.locator('.item.assistant', { hasText: /approved: run/ })).toBeVisible()
  await expect(page.locator('.unseen-mark')).toBeVisible()
})

async function showSessions(page: import('@playwright/test').Page) {
  const bar = page.getByRole('navigation', { name: 'Views' })
  if (await bar.isVisible()) await bar.getByRole('button', { name: /^Sessions/ }).click()
}
