import fs from 'node:fs'
import os from 'node:os'
import { expect, test, type Page } from '@playwright/test'
import { token } from '../playwright.config'
import { openNewSession, showPane } from './pane'

// menuFor opens a session row's "⋯" menu in the sidebar.
async function menuFor(page: Page, name: string) {
  await showPane(page, 'Sessions')
  await page.getByRole('button', { name: `Actions for ${name}` }).click()
  return page.getByRole('menu', { name })
}

// ownDir is a fresh folder of the test's own: the shared /tmp group holds
// every other spec's sessions, which push a row under "Show N older".
const ownDir = () => fs.realpathSync(fs.mkdtempSync(`${os.tmpdir()}/gc-archive-`))

test('archives, unarchives and deletes a session, live in another tab', async ({ page, context }, info) => {
  const name = `Put away ${info.project.name} ${info.repeatEachIndex}`
  await page.goto(`/?token=${token}`)
  await openNewSession(page)
  await page.getByLabel('Working directory').fill(ownDir())
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await page.getByRole('button', { name: 'Rename session' }).click()
  await page.getByRole('textbox', { name: 'Session name' }).fill(name)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name })).toBeVisible()

  // A second tab watches the list change without a reload.
  const other = await context.newPage()
  await other.goto('/')
  await showPane(other, 'Sessions')
  const otherList = other.locator('.groups')
  await expect(otherList.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible()

  const list = page.locator('.groups')
  const archived = page.locator('details.archived')
  await (await menuFor(page, name)).getByRole('menuitem', { name: 'Archive' }).click()
  await expect(list.getByRole('button', { name: new RegExp(`^${name}`) })).toHaveCount(0)
  await expect(otherList.getByRole('button', { name: new RegExp(`^${name}`) })).toHaveCount(0)
  // The open session stays open, so its fold opens to show where you are.
  await expect(archived).toHaveAttribute('open', '')
  const shelved = archived.getByRole('button', { name: new RegExp(`^${name}`) })
  await expect(shelved).toBeVisible()
  // The focus follows the row there: a neighbour taking it would scroll the
  // list away again, sooner or later depending on which lands first, the
  // archive's answer or the live update.
  await expect(shelved).toBeFocused()
  // ...and its row is in sight, not under the account footer (the Undo
  // notice floats above everything and is left out).
  await expect
    .poll(() =>
      shelved.evaluate((el) => {
        const r = el.getBoundingClientRect()
        const hit = document.elementsFromPoint(r.x + r.width / 2, r.y + r.height / 2).find((e) => !e.closest('.notices'))
        return !!hit && el.contains(hit)
      }),
    )
    .toBe(true)

  // Still works when opened: a message goes through.
  await showPane(page, 'Chat')
  await page.getByLabel('Message').fill('still here')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText('echo: still here')).toBeVisible()

  await (await menuFor(page, name)).getByRole('menuitem', { name: 'Unarchive' }).click()
  await expect(list.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible()
  await expect(otherList.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible()

  // Delete asks first, and keeps the session when told to.
  let menu = await menuFor(page, name)
  await menu.getByRole('menuitem', { name: 'Delete…' }).click()
  const confirm = page.getByRole('group', { name: `Delete ${name}?` })
  await expect(confirm).toContainText("transcript on disk stays")
  // the popover may cover the row: its question names the session
  await expect(confirm).toContainText(`Delete “${name}” from go-chamber?`)
  await confirm.getByRole('button', { name: 'Keep' }).click()
  await expect(list.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible()

  menu = await menuFor(page, name)
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.getByRole('group', { name: `Delete ${name}?` }).getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(list.getByRole('button', { name: new RegExp(`^${name}`) })).toHaveCount(0)
  await expect(otherList.getByRole('button', { name: new RegExp(`^${name}`) })).toHaveCount(0)
  // The open session is gone: back to the empty state at /.
  await showPane(page, 'Chat')
  await expect(page.getByRole('heading', { name: 'Start a session' })).toBeVisible()
  await expect(page).toHaveURL(/\/$/)
  await page.reload()
  await showPane(page, 'Sessions')
  await expect(page.locator('.groups')).not.toContainText(name)
})

test('archiving a session that waits for you keeps the request in sight, with an Undo', async ({ page }, info) => {
  const name = `Waits ${info.project.name} ${info.repeatEachIndex} ${Date.now()}`
  await page.goto(`/?token=${token}`)
  await openNewSession(page)
  await page.getByLabel('Working directory').fill(ownDir())
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await page.getByRole('button', { name: 'Rename session' }).click()
  await page.getByRole('textbox', { name: 'Session name' }).fill(name)
  await page.keyboard.press('Enter')
  await page.getByLabel('message').fill('please permission')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.request-title', { hasText: 'Run command' })).toBeVisible()

  await (await menuFor(page, name)).getByRole('menuitem', { name: 'Archive' }).click()
  const archived = page.locator('details.archived')
  const row = archived.getByRole('button', { name: new RegExp(`^${name}`) })
  await expect(row).toContainText('waiting for you')
  await expect(archived.locator('summary .badge')).toBeVisible()

  const notice = page.getByRole('status').filter({ hasText: `Archived ${name}` })
  await notice.getByRole('button', { name: 'Undo' }).click()
  const restored = page.locator('.groups').getByRole('button', { name: new RegExp(`^${name}`) })
  await expect(restored).toBeVisible()
  // The focus lands where the session is used: its composer, or its row on a phone's list.
  if (await page.getByLabel('Message').isVisible()) await expect(page.getByLabel('Message')).toBeFocused()
  else await expect(restored).toBeFocused()
  await showPane(page, 'Chat')
  await page.getByRole('button', { name: 'Allow', exact: true }).click()
})

test('a failed archive closes the menu and says why', async ({ page }) => {
  const headers = { Authorization: `Bearer ${token}` }
  const created = await page.request.post('/api/sessions', { headers, data: { agent: 'claude', cwd: ownDir() } })
  const { id } = (await created.json()) as { id: string }
  await page.route(`**/api/sessions/${id}/archive`, (route) => route.fulfill({ status: 500, body: 'disk full' }))
  await page.goto(`/s/${id}?token=${token}`)
  await showPane(page, 'Sessions')
  await page.locator('li:has(> button.session[aria-current="true"]) > .session-menu-trigger').click()
  await page.getByRole('menu').getByRole('menuitem', { name: 'Archive' }).click()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(page.locator('.notices')).toContainText("Couldn't archive the session")
})

test('a search looks in Archived too, and says when only archived sessions match', async ({ page }) => {
  const headers = { Authorization: `Bearer ${token}` }
  const dir = `${ownDir()}/shelved-search-${Date.now()}`
  fs.mkdirSync(dir)
  const created = await page.request.post('/api/sessions', { headers, data: { agent: 'claude', cwd: dir } })
  const { id } = (await created.json()) as { id: string }
  await page.request.post(`/api/sessions/${id}/archive`, { headers })
  await page.goto(`/?token=${token}`)
  await showPane(page, 'Sessions')
  const archived = page.locator('details.archived')
  await expect(archived).toBeVisible()
  await page.getByLabel('Search sessions').fill(dir.split('/').pop()!)
  await expect(page.getByText('Only archived sessions match')).toBeVisible()
  await expect(archived).toHaveAttribute('open', '')
  await expect(archived.locator('summary .group-count')).toHaveText('1')
  await expect(page.locator('.sidebar-body')).toHaveJSProperty('scrollTop', 0)
  await page.getByLabel('Search sessions').fill('zz-nothing-matches-this')
  await expect(page.getByText('No matching sessions')).toBeVisible()
  await expect(archived).toHaveCount(0)
})
