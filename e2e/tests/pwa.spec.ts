import { expect, test } from '@playwright/test'
import { token } from '../playwright.config'

test('the app is installable and its service worker runs', async ({ page, request }) => {
  const manifest = await request.get('/manifest.webmanifest')
  expect(manifest.ok()).toBe(true)
  const body = await manifest.json()
  expect(body.display).toBe('standalone')
  for (const icon of body.icons as { src: string }[]) {
    expect((await request.get(icon.src)).ok(), icon.src).toBe(true)
  }

  await page.goto(`/?token=${token}`)
  await expect(page.getByText('online')).toBeVisible()
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope)
  expect(scope).toMatch(/\/$/)
  await expect(page.getByRole('button', { name: 'Notifications' })).toBeVisible()
})
