import { expect, test } from '@playwright/test'
import { token } from '../playwright.config'

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
