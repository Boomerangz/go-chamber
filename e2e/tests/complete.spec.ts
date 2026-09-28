import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { token } from '../playwright.config'
import { showPane } from './pane'

test('completes @files and /commands in the composer', async ({ page }) => {
  const dir = fs.realpathSync(fs.mkdtempSync(`${os.tmpdir()}/gc-complete-`))
  fs.mkdirSync(path.join(dir, 'src'))
  fs.writeFileSync(path.join(dir, 'src', 'main.go'), 'package main\n')
  fs.writeFileSync(path.join(dir, 'README.md'), '# hi\n')

  await page.goto(`/?token=${token}`)
  await showPane(page, 'Sessions')
  await page.getByRole('radio', { name: 'Claude' }).click()
  await page.getByLabel('working directory').fill(dir)
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  const box = page.getByLabel('message')
  await expect(box).toBeVisible()

  await box.fill('/rev')
  await expect(page.getByRole('option', { name: /\/review-mr/ })).toBeVisible()
  await box.press('Tab')
  await expect(box).toHaveValue('/review-mr ')

  await box.fill('see @mai')
  await expect(page.getByRole('option', { name: 'src/main.go' })).toBeVisible()
  await box.press('Enter')
  await expect(box).toHaveValue('see @src/main.go ')
  await expect(page.getByRole('listbox')).toHaveCount(0)
})
