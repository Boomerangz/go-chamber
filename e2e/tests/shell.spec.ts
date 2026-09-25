import { expect, test } from '@playwright/test'
import { token } from '../playwright.config'

test('rejects visitors without token', async ({ page }) => {
  const res = await page.goto('/')
  expect(res?.status()).toBe(401)
})

test('token login shows the app online and drops token from URL', async ({ page }) => {
  await page.goto(`/?token=${token}`)
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('heading', { name: 'go-chamber' })).toBeVisible()
  await expect(page.getByText('online')).toBeVisible()
})

test('client-side routes fall back to the app after login', async ({ page }) => {
  await page.goto(`/?token=${token}`)
  await page.goto('/sessions/anything')
  await expect(page.getByRole('heading', { name: 'go-chamber' })).toBeVisible()
})
