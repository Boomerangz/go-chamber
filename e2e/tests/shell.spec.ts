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
  await expect(page.getByRole('status', { name: 'online' })).toBeVisible()
})

test('client-side routes fall back to the app after login', async ({ page }) => {
  await page.goto(`/?token=${token}`)
  await page.goto('/sessions/anything')
  await expect(page.getByRole('heading', { name: 'go-chamber' })).toBeVisible()
})

test('signs in with the login form, returns to the page, and signs out', async ({ page }) => {
  await page.goto('/sessions/anything')
  await page.getByLabel('Access token').fill('wrong')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('alert')).toHaveText('Wrong token')
  await page.getByLabel('Access token').fill(token)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/sessions\/anything$/)
  await expect(page.getByRole('status', { name: 'online' })).toBeVisible()

  const cookie = (await page.context().cookies()).find((c) => c.name === 'gc_token')!
  expect(cookie.expires).toBeGreaterThan(Date.now() / 1000 + 300 * 24 * 3600)

  const signOut = page.getByRole('button', { name: 'Sign out' })
  if (await signOut.isVisible()) {
    await signOut.click()
    await page.getByRole('button', { name: 'Sign out' }).filter({ visible: true }).click()
    await expect(page.getByLabel('Access token')).toBeVisible()
  }
})
