import { expect, test } from '@playwright/test'
import { token } from '../playwright.config'

test('focus leaves only the chat and opens the requests when the agent asks', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', 'one pane at a time already')
  const text = `focus ${info.repeatEachIndex} ${Date.now()}: please permission`
  await page.goto(`/?token=${token}`)
  await page.getByLabel('working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByLabel('message')).toBeVisible()

  await page.getByRole('button', { name: 'Focus' }).click()
  await expect(page.locator('.sidebar')).toBeHidden()
  await expect(page.getByRole('toolbar', { name: 'Dock' })).toBeHidden()

  await page.getByLabel('message').fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
  const line = page.getByRole('complementary', { name: 'Pending requests' }).getByRole('listitem').filter({ hasText: text })
  await expect(line).toBeVisible()
  await page.screenshot({ path: 'test-results/focus.png' })
  await line.getByRole('button', { name: 'Allow', exact: true }).click()
  await expect(page.locator('.item.assistant', { hasText: /approved: run/ })).toBeVisible()

  // the focus survives a reload
  await page.reload()
  await expect(page.getByRole('button', { name: 'Focus' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.sidebar')).toBeHidden()
})
