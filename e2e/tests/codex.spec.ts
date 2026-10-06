import { expect, test } from '@playwright/test'
import { token } from '../playwright.config'
import { openNewSession, showSessionDetails } from './pane'

async function newCodexSession(page: import('@playwright/test').Page, cwd = '/tmp') {
  await page.goto(`/?token=${token}`)
  await openNewSession(page)
  await page.getByRole('radio', { name: 'Codex' }).click()
  await page.getByLabel('Working directory').fill(cwd)
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByLabel('Message')).toBeVisible()
}

test('streams a codex app-server reply', async ({ page }) => {
  await newCodexSession(page)
  await page.getByLabel('Message').fill('hello codex')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.item.assistant', { hasText: 'echo: hello codex' })).toBeVisible()
})

test('approves a codex command execution', async ({ page }) => {
  await newCodexSession(page)
  await page.getByLabel('Message').fill('please permission')
  await page.getByRole('button', { name: 'Send' }).click()

  await expect(page.locator('.request-title', { hasText: 'please permission' })).toBeVisible()
  await page.getByRole('button', { name: 'Allow', exact: true }).click()
  await expect(page.locator('.item.assistant', { hasText: 'approved: please permission' })).toBeVisible()
})

// Stop ends a codex turn waiting on an approval: the request leaves, the
// command it held reads stopped and the turn says it was stopped.
test('stops a codex turn that waits for an approval', async ({ page }) => {
  await newCodexSession(page)
  await page.getByLabel('Message').fill('please permission to stop')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.request-title', { hasText: 'please permission to stop' })).toBeVisible()
  const composer = page.locator('form.composer')
  await composer.getByRole('button', { name: 'Stop' }).click()
  await expect(composer.getByRole('button', { name: /^Stop/ })).toHaveCount(0)
  await expect(page.locator('.request-title')).toHaveCount(0)
  await expect(page.locator('.turn-foot .stop-kw')).toHaveText('turn stopped')
  await expect(page.locator('.item .stop-tag').first()).toHaveText('stopped')
  // The next turn starts clean, with its own reply.
  await page.getByLabel('Message').fill('hello again')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.item.assistant', { hasText: 'echo: hello again' })).toBeVisible()
})

test('answers a codex requestUserInput question', async ({ page }) => {
  await newCodexSession(page)
  await page.getByLabel('Message').fill('ask me')
  await page.getByRole('button', { name: 'Send' }).click()

  await expect(page.locator('legend', { hasText: 'Which option should we use?' })).toBeVisible()
  await page.getByRole('radio', { name: /Alpha/ }).click()
  await page.getByRole('button', { name: 'Submit' }).click()
  await expect(page.locator('.item.assistant', { hasText: /answered/ })).toBeVisible()
})

test('starts a codex device-code login', async ({ page }) => {
  await page.goto(`/?token=${token}`)
  await openNewSession(page)
  await page.getByRole('radio', { name: 'Codex' }).click()
  await expect(page.getByRole('button', { name: 'Sign in to Codex' })).toBeVisible()
  await page.getByRole('button', { name: 'Sign in to Codex' }).click()
  await expect(page.getByText('ABCD-EFGH')).toBeVisible()
  await expect(page.getByRole('link', { name: 'https://example.com/device' })).toBeVisible()
})

test('switches who reviews codex approvals', async ({ page }, info) => {
  const cwd = `/tmp/reviewer-${info.project.name}-${Date.now()}`
  await newCodexSession(page, cwd)
  await showSessionDetails(page)
  const reviewer = page.getByLabel('Approval reviewer')
  await expect(reviewer).toHaveValue('')

  await reviewer.selectOption('auto_review')
  await page.getByLabel('Message').fill('auto permission run')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.item.assistant', { hasText: 'auto-approved: auto permission run' })).toBeVisible()
  await expect(page.locator('.request-title', { hasText: 'auto permission run' })).toHaveCount(0)

  await reviewer.selectOption('user')
  await page.getByLabel('Message').fill('manual permission run')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.request-title', { hasText: 'manual permission run' })).toBeVisible()
  await page.getByRole('button', { name: 'Allow', exact: true }).click()
  await expect(page.locator('.item.assistant', { hasText: 'approved: manual permission run' }).last()).toBeVisible()

  // The choice survives a reload, which reopens the same session.
  await page.reload()
  await showSessionDetails(page)
  await expect(page.getByLabel('Approval reviewer')).toHaveValue('user')
})
