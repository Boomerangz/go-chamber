import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { token } from '../playwright.config'
import { openNewSession } from './pane'

test('opens files the agent links inside its folder', async ({ page }) => {
  const cwd = mkdtempSync(join(tmpdir(), 'gc-files-'))
  const outside = mkdtempSync(join(tmpdir(), 'gc-outside-'))
  writeFileSync(join(cwd, 'notes.md'), '# Findings\n\nall good')
  writeFileSync(join(outside, 'secret.md'), '# Secret')

  await page.goto(`/?token=${token}`)
  await openNewSession(page)
  await page.getByLabel('Working directory').fill(cwd)
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await page.getByLabel('message').fill(`see [notes](${join(cwd, 'notes.md')}) and [secret](${join(outside, 'secret.md')})`)
  await page.getByRole('button', { name: 'Send' }).click()

  await page.getByRole('link', { name: 'notes' }).click()
  const viewer = page.getByRole('dialog')
  await expect(viewer.getByRole('heading', { name: 'Findings' })).toBeVisible()
  await viewer.getByRole('button', { name: 'Close' }).click()
  await expect(viewer).toBeHidden()

  await page.getByRole('link', { name: 'secret' }).click()
  await expect(page.getByRole('dialog').getByRole('alert')).toHaveText('This file is outside the session folder')
})
