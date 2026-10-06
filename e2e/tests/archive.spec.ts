import { expect, test, type Page } from '@playwright/test'
import { token } from '../playwright.config'
import { openNewSession, showPane } from './pane'

// menuFor opens a session row's "⋯" menu in the sidebar.
async function menuFor(page: Page, name: string) {
  await showPane(page, 'Sessions')
  await page.getByRole('button', { name: `Actions for ${name}` }).click()
  return page.getByRole('menu', { name })
}

test('archives, unarchives and deletes a session, live in another tab', async ({ page, context }, info) => {
  const name = `Put away ${info.project.name} ${info.repeatEachIndex}`
  await page.goto(`/?token=${token}`)
  await openNewSession(page)
  await page.getByLabel('Working directory').fill('/tmp')
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
  await expect(archived.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible()

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
  await page.getByLabel('Working directory').fill('/tmp')
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
  await expect(page.locator('.groups').getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible()
  await showPane(page, 'Chat')
  await page.getByRole('button', { name: 'Allow', exact: true }).click()
})
