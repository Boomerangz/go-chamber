import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { token } from '../playwright.config'
import { openNewSession, showSessionDetails } from './pane'

// The picker browses the server's real filesystem.
test('picks a session folder with the folder picker', async ({ page }) => {
  const root = fs.realpathSync(fs.mkdtempSync(`${os.tmpdir()}/gc-pick-`))
  fs.mkdirSync(path.join(root, 'alpha', '.git'), { recursive: true })
  fs.mkdirSync(path.join(root, 'beta', 'inner'), { recursive: true })
  fs.mkdirSync(path.join(root, '.secret'))

  await page.goto(`/?token=${token}`)
  await openNewSession(page)
  await page.getByRole('button', { name: 'Browse' }).first().click()
  const picker = page.getByRole('dialog', { name: 'Choose a folder' })
  // Parallel projects share the server, so recent-folder chips may repeat names.
  const list = picker.locator('.folder-list')
  await picker.getByLabel('filter folders').fill(root)
  await picker.getByLabel('filter folders').press('Enter')

  await expect(list.getByRole('button', { name: /^alpha/ })).toContainText('git')
  await expect(list.getByRole('button', { name: /secret/ })).toHaveCount(0)
  await picker.getByLabel('Hidden').check()
  await expect(list.getByRole('button', { name: /^\.secret/ })).toBeVisible()

  await list.getByRole('button', { name: /^beta/ }).click()
  await expect(list.getByRole('button', { name: /^inner/ })).toBeVisible()
  await list.getByRole('button', { name: '..' }).click()
  await list.getByRole('button', { name: 'Select beta' }).click()

  await expect(picker).toHaveCount(0)
  await expect(page.getByLabel('working directory')).toHaveValue(path.join(root, 'beta'))
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await showSessionDetails(page)
  await expect(page.locator('.chat-path', { hasText: path.join(root, 'beta') })).toBeVisible()
})
