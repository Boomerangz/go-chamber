import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import { token } from '../playwright.config'
import { showPane } from './pane'

// Sessions are grouped by project folder, titled by their first message
// and searchable by title.
test('groups sessions by project and finds them by title', async ({ page }) => {
  const dir = fs.realpathSync(fs.mkdtempSync(`${os.tmpdir()}/gc-group-`))
  const name = dir.split('/').pop()!
  await page.goto(`/?token=${token}`)
  for (const text of ['first topic', 'second topic']) {
    await showPane(page, 'Sessions')
    await page.getByLabel('working directory').fill(dir)
    await page.getByRole('button', { name: 'New session', exact: true }).click()
    await page.getByLabel('message').fill(text)
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(page.locator('.item.assistant', { hasText: `echo: ${text}` })).toBeVisible()
  }
  await expect(page.locator('.chat-header h2')).toHaveText('second topic')

  await showPane(page, 'Sessions')
  const group = page.getByRole('region', { name: `Project ${name}` })
  await expect(group.locator('.session-title')).toHaveText(['second topic', 'first topic'])

  await group.getByRole('button', { name: new RegExp(`^${name}`) }).click()
  await expect(group.getByRole('button', { name: new RegExp(`^${name}`) })).toHaveAttribute('aria-expanded', 'false')
  // The open session stays visible in a collapsed group.
  await expect(group.locator('.session-title')).toHaveText(['second topic'])

  await page.getByLabel('search sessions').fill('first topic')
  await expect(group.locator('.session-title')).toHaveText(['first topic'])
  await group.locator('.session').click()
  await expect(page.locator('.chat-header h2')).toHaveText('first topic')
})
