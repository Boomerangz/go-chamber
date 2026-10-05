import { expect, test } from '@playwright/test'
import { token } from '../playwright.config'
import { showPane } from './pane'

async function newSession(page: import('@playwright/test').Page) {
  await page.goto(`/?token=${token}`)
  await page.getByLabel('working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByLabel('message')).toBeVisible()
}

test('approves a permission prompt from the fake agent', async ({ page }) => {
  await newSession(page)
  await page.getByLabel('message').fill('please permission')
  await page.getByRole('button', { name: 'Send' }).click()

  await expect(page.locator('.request-title', { hasText: 'Run command' })).toBeVisible()
  await page.getByRole('button', { name: 'Allow', exact: true }).click()
  await expect(page.locator('.item.assistant', { hasText: /approved: run/ })).toBeVisible()
  await expect(page.locator('.request')).toHaveCount(0)
})

test('denies a permission prompt from the fake agent', async ({ page }) => {
  await newSession(page)
  await page.getByLabel('message').fill('please permission')
  await page.getByRole('button', { name: 'Send' }).click()

  await expect(page.locator('.request-title', { hasText: 'Run command' })).toBeVisible()
  await page.getByRole('button', { name: 'Deny', exact: true }).click()
  await page.getByLabel('deny reason').fill('not allowed')
  await page.getByRole('button', { name: 'Confirm deny' }).click()
  await expect(page.locator('.item.assistant', { hasText: 'denied: not allowed' })).toBeVisible()
})

test('answers an AskUserQuestion from the fake agent', async ({ page }) => {
  await newSession(page)
  await page.getByLabel('message').fill('ask me something')
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
  await page.getByLabel('message').fill(text)
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
  await page.getByLabel('message').fill(text)
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
