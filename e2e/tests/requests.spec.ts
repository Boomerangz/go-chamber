import { expect, test } from '@playwright/test'
import { token } from '../playwright.config'
import { openNewSession, showPane } from './pane'

async function newSession(page: import('@playwright/test').Page) {
  await page.goto(`/?token=${token}`)
  await openNewSession(page)
  await page.getByLabel('Working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByLabel('Message')).toBeVisible()
}

test('approves a permission prompt from the fake agent', async ({ page }) => {
  await newSession(page)
  await page.getByLabel('Message').fill('please permission')
  await page.getByRole('button', { name: 'Send' }).click()

  await expect(page.locator('.request-title', { hasText: 'Run command' })).toBeVisible()
  await page.getByRole('button', { name: 'Allow', exact: true }).click()
  await expect(page.locator('.item.assistant', { hasText: /approved: run/ })).toBeVisible()
  await expect(page.locator('.request')).toHaveCount(0)
})

test('denies a permission prompt from the fake agent', async ({ page }) => {
  await newSession(page)
  await page.getByLabel('Message').fill('please permission')
  await page.getByRole('button', { name: 'Send' }).click()

  await expect(page.locator('.request-title', { hasText: 'Run command' })).toBeVisible()
  await page.getByRole('button', { name: 'Deny', exact: true }).click()
  await page.getByLabel('Deny reason').fill('not allowed')
  await page.getByRole('button', { name: 'Confirm deny' }).click()
  await expect(page.locator('.item.assistant', { hasText: 'denied: not allowed' })).toBeVisible()
})

test('answers an AskUserQuestion from the fake agent', async ({ page }) => {
  await newSession(page)
  await page.getByLabel('Message').fill('ask me something')
  await page.getByRole('button', { name: 'Send' }).click()

  await expect(page.locator('legend', { hasText: 'Which option should we use?' })).toBeVisible()
  await page.getByRole('radio', { name: /Alpha/ }).click()
  await page.getByRole('button', { name: 'Submit' }).click()
  await expect(page.locator('.item.assistant', { hasText: /answered:.*Alpha/ })).toBeVisible()
})

test('approves a permission from the requests tray without opening the session card', async ({ page }, info) => {
  // The tray is shared by every session on the server: find this one's line.
  const text = `tray ${info.project.name} ${info.repeatEachIndex} ${Date.now()}: please permission`
  await newSession(page)
  await page.getByLabel('Message').fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.request-title', { hasText: 'Run command' })).toBeVisible()

  const bar = page.getByRole('navigation', { name: 'Views' })
  if (await bar.isVisible()) await bar.getByRole('button', { name: /^Requests/ }).click()
  else await page.getByRole('toolbar', { name: 'Dock' }).getByRole('button', { name: /^Requests/ }).click()
  const line = page.getByRole('complementary', { name: 'Pending requests' }).getByRole('listitem').filter({ hasText: text })
  await line.getByRole('button', { name: 'Allow', exact: true }).click()
  await expect(line).toHaveCount(0)

  await showPane(page, 'Chat')
  await expect(page.locator('.item.assistant', { hasText: /approved: run/ })).toBeVisible()
  await expect(page.locator('.request')).toHaveCount(0)
})

test('approves a permission from the requests tray with the keyboard', async ({ page }, info) => {
  const text = `tray key ${info.project.name} ${info.repeatEachIndex} ${Date.now()}: please permission`
  await newSession(page)
  await page.getByLabel('Message').fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.request-title', { hasText: 'Run command' })).toBeVisible()

  const bar = page.getByRole('navigation', { name: 'Views' })
  if (await bar.isVisible()) await bar.getByRole('button', { name: /^Requests/ }).click()
  else await page.getByRole('toolbar', { name: 'Dock' }).getByRole('button', { name: /^Requests/ }).click()
  const line = page.getByRole('complementary', { name: 'Pending requests' }).getByRole('listitem').filter({ hasText: text })
  await line.locator('.tray-row').focus()
  await page.keyboard.press('a')
  await expect(line).toHaveCount(0)

  await showPane(page, 'Chat')
  await expect(page.locator('.item.assistant', { hasText: /approved: run/ })).toBeVisible()
})

// openTray shows the requests inbox: the pane on phones, the dock on desktop.
async function openTray(page: import('@playwright/test').Page) {
  const bar = page.getByRole('navigation', { name: 'Views' })
  if (await bar.isVisible()) await bar.getByRole('button', { name: /^Requests/ }).click()
  else await page.getByRole('toolbar', { name: 'Dock' }).getByRole('button', { name: /^Requests/ }).click()
}

test('the requests inbox says it failed to load instead of looking empty', async ({ page }) => {
  let failing = true
  await page.route('**/api/requests', (route) =>
    failing ? route.fulfill({ status: 500, body: 'requests broke' }) : route.fallback(),
  )
  await page.goto(`/?token=${token}`)
  await openTray(page)
  const failed = page.locator('.load-failed', { hasText: "Couldn't load requests" })
  await expect(failed).toBeVisible()
  await expect(page.getByText('No pending requests')).toHaveCount(0)
  // shown in place: no notice repeats it
  await expect(page.getByText('requests broke')).toHaveCount(0)
  failing = false
  await failed.getByRole('button', { name: 'Retry' }).click()
  await expect(failed).toHaveCount(0)
})

test('a tray answer on its way names itself', async ({ page }, info) => {
  const text = `tray busy ${info.project.name} ${info.repeatEachIndex} ${Date.now()}: please permission`
  await newSession(page)
  await page.getByLabel('Message').fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.request-title', { hasText: 'Run command' })).toBeVisible()

  let release: () => void = () => {}
  const held = new Promise<void>((r) => (release = r))
  await page.route('**/api/sessions/*/requests/*', async (route) => {
    await held
    await route.fallback()
  })
  await openTray(page)
  const line = page.getByRole('complementary', { name: 'Pending requests' }).getByRole('listitem').filter({ hasText: text })
  await line.getByRole('button', { name: 'Deny', exact: true }).click()
  await expect(line.getByRole('button', { name: 'Denying…' })).toBeVisible()
  await expect(line.getByRole('button', { name: 'Allow', exact: true })).toBeDisabled()
  release()
  await expect(line).toHaveCount(0)
})

// A turn cut off while a permission waited (the agent process died) still
// waits for the owner: the header says so, and the inbox offers to continue.
test('a turn cut off with a permission open still waits in the inbox', async ({ page }, info) => {
  const text = `cut ${info.project.name} ${Date.now()}: crash while asking`
  await newSession(page)
  await page.getByLabel('Message').fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.banner', { hasText: 'Turn interrupted' })).toContainText('waiting for your answer')
  await expect(page.locator('.chat-meta .status')).toHaveText(/waiting for you/)
  // Nothing of the cut-off turn still reads as running.
  await expect(page.locator('form.composer').getByRole('button', { name: /^Stop/ })).toHaveCount(0)
  // It is kept: a reload (a fresh list from the server) still knows.
  await page.reload()
  await expect(page.locator('.chat-meta .status')).toHaveText(/waiting for you/)

  const bar = page.getByRole('navigation', { name: 'Views' })
  if (await bar.isVisible()) await bar.getByRole('button', { name: /^Requests/ }).click()
  else await page.getByRole('toolbar', { name: 'Dock' }).getByRole('button', { name: /^Requests/ }).click()
  const line = page.getByRole('complementary', { name: 'Pending requests' }).getByRole('listitem').filter({ hasText: text })
  await expect(line).toContainText('interrupted — continue?')
  await line.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(line).toHaveCount(0)
})
