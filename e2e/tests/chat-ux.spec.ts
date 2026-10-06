import { expect, test, type Page } from '@playwright/test'
import { token } from '../playwright.config'
import { openNewSession, showPane } from './pane'

async function newSession(page: Page) {
  await page.goto(`/?token=${token}`)
  await showPane(page, 'Sessions')
  await openNewSession(page)
  await page.getByLabel('working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByLabel('message')).toBeVisible()
}

async function say(page: Page, text: string) {
  await page.getByLabel('message').fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.item.assistant', { hasText: `echo: ${text}` })).toBeVisible()
  await expect(page.locator('.chat-meta .status', { hasText: 'idle' })).toBeVisible()
}

test('shows a message on its way and keeps the draft when it fails', async ({ page }) => {
  await newSession(page)
  await page.route('**/api/sessions/*/messages', async (route) => {
    await new Promise((r) => setTimeout(r, 600))
    await route.fulfill({ status: 500, body: 'agent unavailable' })
  })
  await page.getByLabel('message').fill('will not arrive')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.row-pending', { hasText: 'will not arrive' })).toContainText('sending…')
  await expect(page.locator('.row-pending')).toHaveCount(0)
  await expect(page.getByLabel('message')).toHaveValue('will not arrive')
})

test('brings sent messages back with ArrowUp', async ({ page }) => {
  await newSession(page)
  await say(page, 'first thing')
  await say(page, 'second thing')
  await page.getByLabel('message').focus()
  await page.keyboard.press('ArrowUp')
  await expect(page.getByLabel('message')).toHaveValue('second thing')
  await page.keyboard.press('ArrowUp')
  await expect(page.getByLabel('message')).toHaveValue('first thing')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(page.getByLabel('message')).toHaveValue('')
})

test('sends with Enter and breaks lines with Shift+Enter', async ({ page, isMobile }) => {
  test.skip(isMobile, 'on a touch screen Enter is the newline')
  await newSession(page)
  await expect(page.locator('.composer-keys')).toContainText('send')
  const box = page.getByLabel('message')
  await box.fill('two')
  await box.press('Shift+Enter')
  await box.pressSequentially('lines')
  await expect(box).toHaveValue('two\nlines')
  await expect(page.getByRole('button', { name: 'Send' })).toHaveAttribute('title', 'Send (↵)')
  await box.press('Enter')
  await expect(page.locator('.item.user', { hasText: 'lines' })).toBeVisible()
  await expect(box).toHaveValue('')
})

test('keeps Enter a newline on a touch screen', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'touch screens only')
  await newSession(page)
  const box = page.getByLabel('message')
  await box.fill('a')
  await box.press('Enter')
  await expect(box).toHaveValue('a\n')
  await expect(page.locator('.row-pending')).toHaveCount(0)
})

test('moves focus on after a request is answered', async ({ page, isMobile }) => {
  test.skip(isMobile, 'a phone keeps the keyboard down')
  await newSession(page)
  await page.getByLabel('message').fill('please permission')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.request-title', { hasText: 'Run command' })).toBeVisible()
  await page.getByRole('button', { name: 'Allow', exact: true }).click()
  await expect(page.locator('.item.assistant', { hasText: /approved: run/ })).toBeVisible()
  await expect(page.getByLabel('message')).toBeFocused()
})

test('says live updates paused when the socket drops, and reconnects', async ({ page }) => {
  let drop = () => {}
  await page.routeWebSocket('**/api/ws', (ws) => {
    const server = ws.connectToServer()
    drop = () => {
      void server.close()
      void ws.close()
    }
  })
  await newSession(page)
  await expect(page.locator('.live-strip')).toHaveCount(0)
  drop()
  const strip = page.getByRole('status', { name: 'live updates' })
  await expect(strip).toContainText('live updates paused')
  await strip.getByRole('button', { name: 'Reconnect now' }).click()
  await expect(strip).toHaveCount(0)
})

test('says a session that does not exist was not found', async ({ page }) => {
  await page.goto(`/s/no-such-session?token=${token}`)
  await expect(page.getByRole('heading', { name: 'Session not found' })).toBeVisible()
  await page.getByRole('button', { name: 'Back to sessions' }).click()
  await expect(page).toHaveURL(/\/(\?.*)?$/)
  await expect(page.getByRole('heading', { name: 'Session not found' })).toHaveCount(0)
})

test('folds the session header on a phone', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'the header folds only on a narrow screen')
  await newSession(page)
  await expect(page.getByLabel('permission mode')).toBeHidden()
  const height = (await page.locator('.chat-header').boundingBox())!.height
  expect(height).toBeLessThan(110)
  await page.getByRole('button', { name: 'session details' }).click()
  await expect(page.getByLabel('permission mode')).toBeVisible()
  await expect(page.locator('.chat-path')).toBeVisible()
})
