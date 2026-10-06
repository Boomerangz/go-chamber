import { expect, test } from '@playwright/test'
import { token } from '../playwright.config'
import { openNewSession } from './pane'

test('streams a fake agent reply end to end', async ({ page }) => {
  await page.goto(`/?token=${token}`)

  await openNewSession(page)
  await page.getByLabel('Working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session', exact: true }).click()

  await expect(page.getByLabel('Message')).toBeVisible()
  await page.getByLabel('Message').fill('hello')
  await page.getByRole('button', { name: 'Send' }).click()

  await expect(page.locator('.item.user', { hasText: 'hello' })).toBeVisible()
  await expect(page.getByText('echo: hello')).toBeVisible()
  await expect(page.locator('.chat-meta .status', { hasText: 'idle' })).toBeVisible()
})

test('shows a tool call card from the fake agent', async ({ page }) => {
  await page.goto(`/?token=${token}`)
  await openNewSession(page)
  await page.getByLabel('Working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByLabel('Message')).toBeVisible()

  await page.getByLabel('Message').fill('bash it')
  await page.getByRole('button', { name: 'Send' }).click()

  await expect(page.getByText('done: bash it')).toBeVisible()
})
