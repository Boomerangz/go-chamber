import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import { token } from '../playwright.config'
import { openNewSession, showPane } from './pane'

// Sessions are grouped by project folder, titled by their first message
// and searchable by title.
test('groups sessions by project and finds them by title', async ({ page }, info) => {
  const dir = fs.realpathSync(fs.mkdtempSync(`${os.tmpdir()}/gc-group-`))
  const name = dir.split('/').pop()!
  await page.goto(`/?token=${token}`)
  for (const text of ['first topic', 'second topic']) {
    await showPane(page, 'Sessions')
    await openNewSession(page)
    await page.getByLabel('Working directory').fill(dir)
    await page.getByRole('button', { name: 'New session', exact: true }).click()
    // the new session's empty chat, not the previous one still on screen
    await expect(page.locator('.chat-hint')).toBeVisible()
    await page.getByLabel('Message').fill(text)
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(page.locator('.item.assistant', { hasText: `echo: ${text}` })).toBeVisible()
  }
  await expect(page.locator('.chat-header h2')).toHaveText('second topic')
  // A later message doesn't rename the session but is found by content.
  // unique per project: the search below drops the last 3 characters
  const word = `quasar${info.project.name}${Date.now()}`
  await page.getByLabel('Message').fill(`mention ${word} here`)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.item.assistant', { hasText: word })).toBeVisible()

  await showPane(page, 'Sessions')
  const group = page.getByRole('region', { name: `Project ${name}` })
  await expect(group.locator('.session-title')).toHaveText(['second topic', 'first topic'])

  await group.getByRole('button', { name: new RegExp(`^${name}`) }).click()
  await expect(group.getByRole('button', { name: new RegExp(`^${name}`) })).toHaveAttribute('aria-expanded', 'false')
  // The open session stays visible in a collapsed group.
  await expect(group.locator('.session-title')).toHaveText(['second topic'])

  await page.getByLabel('Search sessions').fill('first topic')
  await expect(group.locator('.session-title')).toHaveText(['first topic'])
  await group.locator('.session').click()
  await expect(page.locator('.chat-header h2')).toHaveText('first topic')

  await showPane(page, 'Sessions')
  await page.getByLabel('Search sessions').fill(word.slice(0, -3))
  const hits = page.getByRole('region', { name: 'Message matches' })
  await expect(hits.locator('.session-title')).toHaveText(['second topic'])
  await expect(hits.locator('mark').first()).toContainText(word)
  await hits.locator('.session').click()
  await expect(page.locator('.chat-header h2')).toHaveText('second topic')
})
