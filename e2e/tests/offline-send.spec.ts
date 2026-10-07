import { expect, test, type Page } from '@playwright/test'
import { token } from '../playwright.config'
import { openNewSession, showPane } from './pane'

async function say(page: Page, text: string) {
  await page.getByLabel('Message', { exact: true }).fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.item.assistant', { hasText: `echo: ${text}` })).toBeVisible()
  await expect(page.locator('.chat-meta .status', { hasText: 'idle' })).toBeVisible()
}

// How far the transcript's end sits below what its box shows.
const gap = (page: Page) =>
  page.locator('.chat .scroll').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)

// A phone at the end of a chat loses the server: the strip that says so
// takes room from the transcript, and a message sent meanwhile waits. Both
// stay in view: the end of the chat and the owner's own waiting message.
test('the end of the chat and a message sent while offline stay in view', async ({ page }) => {
  let dropped = false
  let drop = () => {}
  await page.routeWebSocket('**/api/ws', (ws) => {
    if (dropped) return void ws.close()
    const server = ws.connectToServer()
    drop = () => {
      dropped = true
      void server.close()
      void ws.close()
    }
  })
  await page.setViewportSize({ width: 390, height: 640 })
  await page.goto(`/?token=${token}`)
  await showPane(page, 'Sessions')
  await openNewSession(page)
  await page.getByLabel('Working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible()
  for (let i = 1; i <= 5; i++) await say(page, `note ${i} with enough words in it to take a few lines on a phone screen`)
  await expect.poll(() => gap(page)).toBeLessThan(2)

  drop()
  await expect(page.locator('.live-strip')).toContainText('live updates paused')
  await expect.poll(() => gap(page)).toBeLessThan(2)

  await page.getByLabel('Message', { exact: true }).fill('sent while offline')
  await page.getByRole('button', { name: 'Send' }).click()
  const waiting = page.locator('.row-pending', { hasText: 'sent while offline' })
  await expect(waiting).toContainText('waits for go-chamber')
  await expect.poll(() => gap(page)).toBeLessThan(2)
  await expect(waiting).toBeInViewport({ ratio: 1 })
  await expect(page.locator('.jump-latest')).toHaveCount(0)
  dropped = false
})
