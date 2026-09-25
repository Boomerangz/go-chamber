import { expect, test } from '@playwright/test'
import { token } from '../playwright.config'

async function newCodexSession(page: import('@playwright/test').Page) {
  await page.goto(`/?token=${token}`)
  await page.getByLabel('agent').selectOption('codex')
  await page.getByLabel('working directory').fill('/tmp')
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
  await page.getByLabel('agent').selectOption('codex')
  await expect(page.getByRole('button', { name: 'Sign in to Codex' })).toBeVisible()
  await page.getByRole('button', { name: 'Sign in to Codex' }).click()
  await expect(page.getByText('ABCD-EFGH')).toBeVisible()
  await expect(page.getByRole('link', { name: 'https://example.com/device' })).toBeVisible()
})
