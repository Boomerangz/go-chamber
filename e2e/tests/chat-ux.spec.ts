import { expect, test, type Page } from '@playwright/test'
import { token } from '../playwright.config'
import { openNewSession, showPane } from './pane'

async function newSession(page: Page) {
  await page.goto(`/?token=${token}`)
  await showPane(page, 'Sessions')
  await openNewSession(page)
  await page.getByLabel('Working directory').fill('/tmp')
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

test('sends messages typed in quick succession one by one, in order', async ({ page, isMobile }) => {
  test.skip(isMobile, 'on a touch screen Enter is the newline')
  await newSession(page)
  // A slow network keeps each message on its way while the next is typed.
  for (const path of ['messages', 'steer']) {
    await page.route(`**/api/sessions/*/${path}`, async (route) => {
      await new Promise((r) => setTimeout(r, 400))
      await route.continue()
    })
  }
  const box = page.getByLabel('message')
  for (const text of ['rapid 1', 'rapid 2', 'rapid 3']) {
    await box.fill(text)
    await box.press('Enter')
    await expect(box).toHaveValue('')
  }
  await expect(page.locator('.row-pending')).toHaveCount(3)
  const users = page.locator('.row-user_message:not(.row-pending) .user-text')
  await expect(users).toHaveText(['rapid 1', 'rapid 2', 'rapid 3'])
})

test('the header and the sessions list show one status', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the list is another pane on a phone')
  await newSession(page)
  // A session that never ran is idle, not detached.
  await expect(page.locator('.chat-meta .status')).toHaveText('idle')
  await expect(page.locator('.session.active .session-status-detached')).toHaveCount(0)
  await page.getByLabel('message').fill('please permission')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.chat-meta .status')).toHaveText('waiting for you')
  await expect(page.locator('.chat-meta .status')).toHaveClass(/status-waiting/)
  await expect(page.locator('.session.active .session-status-waiting')).toHaveText('waiting for you')
})

test('a draft of several lines gets the whole composer width', async ({ page }) => {
  await newSession(page)
  const box = page.getByLabel('message')
  const width = async () => {
    const form = (await page.locator('form.composer').boundingBox())!
    const area = (await box.boundingBox())!
    return { form: form.width, area: area.width }
  }
  await box.fill('one\ntwo\nthree')
  await expect(page.locator('form.composer')).toHaveClass(/multiline/)
  let w = await width()
  expect(w.area).toBeGreaterThan(w.form - 40)
  // A long line that wraps does the same.
  await box.fill('word '.repeat(80))
  await expect(page.locator('form.composer')).toHaveClass(/multiline/)
  w = await width()
  expect(w.area).toBeGreaterThan(w.form - 40)
  await box.fill('short')
  await expect(page.locator('form.composer')).not.toHaveClass(/multiline/)
})

test('cuts a long command to one line', async ({ page }) => {
  await newSession(page)
  const long = `bash ${'some/rather/long/path/segment '.repeat(12)}`.trim()
  await page.getByLabel('message').fill(long)
  await page.getByRole('button', { name: 'Send' }).click()
  const code = page.locator('.item.command .item-line > code')
  await expect(code).toHaveAttribute('title', `echo ${long}`)
  const box = (await code.boundingBox())!
  expect(box.height).toBeLessThan(24)
  expect(await code.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
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

test('keeps the session header one height with any dock open', async ({ page, isMobile }) => {
  test.skip(isMobile, 'a phone has no dock')
  await newSession(page)
  const header = page.locator('.chat-header')
  const height = async () => Math.round((await header.boundingBox())!.height)
  const base = await height()
  const dock = page.getByRole('toolbar', { name: 'Dock' })
  for (const name of ['Requests', 'Terminal', 'Changes']) {
    await dock.getByRole('button', { name }).click()
    await expect.poll(height).toBe(base)
    expect(await header.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    await dock.getByRole('button', { name }).click()
  }
  // A Codex session, with its approvals choice, takes the same height.
  await showPane(page, 'Sessions')
  await openNewSession(page)
  await page.getByRole('radio', { name: 'Codex' }).click()
  await page.getByLabel('Working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.locator('.chat-header .avatar-codex')).toBeVisible()
  await expect.poll(height).toBe(base)
  await dock.getByRole('button', { name: 'Terminal' }).click()
  await expect.poll(height).toBe(base)
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
