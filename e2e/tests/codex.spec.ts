import { expect, test } from '@playwright/test'
import { token } from '../playwright.config'

async function newCodexSession(page: import('@playwright/test').Page, cwd = '/tmp') {
  await page.goto(`/?token=${token}`)
  await page.getByRole('radio', { name: 'Codex' }).click()
  await page.getByLabel('working directory').fill(cwd)
  await page.getByRole('button', { name: 'New session' }).click()
  await expect(page.getByLabel('message')).toBeVisible()
}

test('streams a codex app-server reply', async ({ page }) => {
  await newCodexSession(page)
  await page.getByLabel('message').fill('hello codex')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.item.assistant', { hasText: 'echo: hello codex' })).toBeVisible()
})

test('approves a codex command execution', async ({ page }) => {
  await newCodexSession(page)
  await page.getByLabel('message').fill('please permission')
  await page.getByRole('button', { name: 'Send' }).click()

  await expect(page.locator('.request-title', { hasText: 'please permission' })).toBeVisible()
  await page.getByRole('button', { name: 'Allow', exact: true }).click()
  await expect(page.locator('.item.assistant', { hasText: 'approved: please permission' })).toBeVisible()
})

test('answers a codex requestUserInput question', async ({ page }) => {
  await newCodexSession(page)
  await page.getByLabel('message').fill('ask me')
  await page.getByRole('button', { name: 'Send' }).click()

  await expect(page.locator('legend', { hasText: 'Which option should we use?' })).toBeVisible()
  await page.getByRole('radio', { name: /Alpha/ }).click()
  await page.getByRole('button', { name: 'Submit' }).click()
  await expect(page.locator('.item.assistant', { hasText: /answered/ })).toBeVisible()
})

test('starts a codex device-code login', async ({ page }) => {
  await page.goto(`/?token=${token}`)
  await page.getByRole('radio', { name: 'Codex' }).click()
  await expect(page.getByRole('button', { name: 'Sign in to Codex' })).toBeVisible()
  await page.getByRole('button', { name: 'Sign in to Codex' }).click()
  await expect(page.getByText('ABCD-EFGH')).toBeVisible()
  await expect(page.getByRole('link', { name: 'https://example.com/device' })).toBeVisible()
})

test('switches who reviews codex approvals', async ({ page }, info) => {
  const cwd = `/tmp/reviewer-${info.project.name}-${Date.now()}`
  await newCodexSession(page, cwd)
  const reviewer = page.getByLabel('approval reviewer')
  await expect(reviewer).toHaveValue('')

  await reviewer.selectOption('auto_review')
  await page.getByLabel('message').fill('auto permission run')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.item.assistant', { hasText: 'auto-approved: auto permission run' })).toBeVisible()
  await expect(page.locator('.request-title', { hasText: 'auto permission run' })).toHaveCount(0)

  await reviewer.selectOption('user')
  await page.getByLabel('message').fill('manual permission run')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.request-title', { hasText: 'manual permission run' })).toBeVisible()
  await page.getByRole('button', { name: 'Allow', exact: true }).click()
  await expect(page.locator('.item.assistant', { hasText: 'approved: manual permission run' }).last()).toBeVisible()

  // The choice survives a reload.
  await page.reload()
  await page.getByRole('button', { name: cwd }).click()
  await expect(page.getByLabel('approval reviewer')).toHaveValue('user')
})
