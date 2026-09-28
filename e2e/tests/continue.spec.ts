import { expect, test } from '@playwright/test'
import { token } from '../playwright.config'

async function newSession(page: import('@playwright/test').Page) {
  await page.goto(`/?token=${token}`)
  const bar = page.getByRole('navigation', { name: 'Views' })
  if (await bar.isVisible()) await bar.getByRole('button', { name: /^Sessions/ }).click()
  await page.getByLabel('working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByLabel('message')).toBeVisible()
}

test('continues a turn cut off by a crash', async ({ page }, info) => {
  await newSession(page)
  await page.getByLabel('message').fill(`crash now ${info.project.name}`)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText('Turn interrupted')).toBeVisible()
  await expect(page.getByText(/exited unexpectedly/)).toBeVisible()

  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(page.getByText('echo: Continue from where you stopped.')).toBeVisible()
  await expect(page.locator('.chat-meta .status', { hasText: 'idle' })).toBeVisible()
  await expect(page.getByText('Turn interrupted')).toHaveCount(0)
})

test('forks a session and keeps talking on the branch', async ({ page }, info) => {
  const text = `fork base ${info.project.name}`
  await newSession(page)
  await page.getByLabel('message').fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText(`echo: ${text}`)).toBeVisible()

  await page.getByRole('button', { name: 'Fork', exact: true }).click()
  await expect(page.getByRole('heading', { name: `${text} (fork)` })).toBeVisible()
  await page.getByLabel('message').fill('on the branch')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText('echo: on the branch')).toBeVisible()

  const bar = page.getByRole('navigation', { name: 'Views' })
  if (await bar.isVisible()) await bar.getByRole('button', { name: /^Sessions/ }).click()
  await expect(page.locator('.session', { hasText: `${text} (fork)` }).locator('.session-fork')).toBeVisible()
})
