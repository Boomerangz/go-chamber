import { expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { token } from '../playwright.config'
import { openNewSession, showPane } from './pane'

// A session whose folder went away, and folders that were never there.

const headers = { Authorization: `Bearer ${token}` }

function newFolder(name: string): string {
  const dir = path.join(realpathSync(mkdtempSync(path.join(tmpdir(), 'gc-e2e-'))), name)
  mkdirSync(dir)
  return dir
}

test('a session whose folder is gone says so in the composer’s place and can be put away', async ({ page }, info) => {
  const cwd = newFolder(`gone-${info.project.name}`)
  const made = (await (await page.request.post('/api/sessions', { headers, data: { agent: 'claude', cwd } })).json()) as { id: string }
  await page.goto(`/s/${made.id}?token=${token}`)
  await expect(page.getByLabel('Message')).toBeVisible()
  // Other tests can invalidate the shared list while this folder disappears.
  // Hold those refreshes until the send itself has reported the missing folder,
  // so this scenario exercises the send-error path rather than the list path.
  let releaseLists!: () => void
  const listsReady = new Promise<void>((resolve) => { releaseLists = resolve })
  await page.route('**/api/sessions', async (route) => {
    if (route.request().method() === 'GET') await listsReady
    await route.continue()
  })
  rmSync(cwd, { recursive: true, force: true })

  // The send is refused with the folder named, once, and no raw chdir error.
  const res = await page.request.post(`/api/sessions/${made.id}/messages`, { headers, data: { text: 'x' } })
  expect(res.status()).toBe(422)
  expect(((await res.json()) as { error: string }).error).toBe(`Folder ${cwd} no longer exists`)

  // Sent from the open chat, the composer gives way; no notice is raised.
  const gone = page.getByRole('group', { name: 'Folder gone' })
  try {
    await page.getByLabel('Message').fill('hello?')
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(gone).toContainText('no longer exists')
  } finally { releaseLists() }
  await expect(page.getByLabel('Message')).toHaveCount(0)
  await expect(page.locator('.toast-error')).toHaveCount(0)
  expect(await gone.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)

  // A reload knows it from the list.
  await page.reload()
  await expect(gone).toBeVisible()
  await expect(page.getByLabel('Message')).toHaveCount(0)
  await gone.getByRole('button', { name: 'Archive' }).click()
  await expect(gone.getByRole('button', { name: 'Archive' })).toHaveCount(0)
  await expect(gone).toBeVisible()
})

test('a gone folder offers no new work: no "+", no form prefill, no shell, no changes to retry', async ({ page, isMobile }, info) => {
  const cwd = newFolder(`doomed-${info.project.name}`)
  const made = (await (await page.request.post('/api/sessions', { headers, data: { agent: 'claude', cwd } })).json()) as { id: string; title?: string }
  await page.request.post(`/api/sessions/${made.id}/title`, { headers, data: { title: `doomed work ${info.project.name}` } })
  rmSync(cwd, { recursive: true, force: true })

  // The server refuses a shell and a change listing there by name and code.
  for (const res of [
    await page.request.post('/api/terminals', { headers, data: { sessionId: made.id } }),
    await page.request.get(`/api/sessions/${made.id}/changes`, { headers }),
  ]) {
    expect(res.status()).toBe(422)
    expect(await res.json()).toEqual({ error: `Folder ${cwd} no longer exists`, code: 'folder_gone' })
  }

  await page.goto(`/s/${made.id}?token=${token}`)
  await expect(page.getByRole('group', { name: 'Folder gone' })).toBeVisible()

  // Changes says it plainly, with nothing to retry.
  const bar = page.getByRole('navigation', { name: 'Views' })
  if (await bar.isVisible()) await bar.getByRole('button', { name: /^Changes/ }).click()
  else await page.getByRole('toolbar', { name: 'Dock' }).getByRole('button', { name: 'Changes' }).click()
  const changes = page.getByRole('region', { name: 'Changes' })
  await expect(changes.getByRole('status', { name: 'Folder gone' })).toContainText('no longer exists')
  await expect(changes.getByRole('button', { name: /Retry|Refresh/ })).toHaveCount(0)
  await expect(changes.getByText(/rev-parse|chdir|no such file/)).toHaveCount(0)

  // The docked terminal offers no shell there.
  if (!isMobile) {
    await page.getByRole('toolbar', { name: 'Dock' }).getByRole('button', { name: /^Terminal/ }).click()
    const shells = page.getByRole('region', { name: 'Terminals' })
    await expect(shells.getByRole('status', { name: 'Folder gone' })).toContainText('no longer exists')
    await expect(shells.getByRole('button', { name: /Open terminal in/ })).toHaveCount(0)
  }

  // The list: its group has no "+", its row says gone; the form doesn't take the folder.
  await showPane(page, 'Sessions')
  const row = page.locator('button.session', { hasText: `doomed work ${info.project.name}` })
  await expect(row.locator('.session-gone')).toBeVisible()
  await expect(page.locator('.group', { has: row }).locator('.group-new')).toHaveCount(0)
  await openNewSession(page)
  await expect(page.getByLabel('Working directory')).not.toHaveValue(cwd)
})

test('a new session in a folder that was never there is refused under the folder field', async ({ page }, info) => {
  const never = path.join(realpathSync(mkdtempSync(path.join(tmpdir(), 'gc-e2e-'))), `never-${info.project.name}`)
  await page.goto(`/?token=${token}`)
  await showPane(page, 'Sessions')
  await openNewSession(page)
  const field = page.getByLabel('Working directory')
  await field.fill(never)
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByRole('alert').filter({ hasText: `Folder ${never} doesn't exist` })).toBeVisible()
  await expect(field).toHaveAttribute('aria-invalid', 'true')
  await expect(page.locator('.toast', { hasText: "doesn't exist" })).toHaveCount(0)

  // A worktree asked for there is refused the same way, not under the branch.
  await page.getByRole('checkbox', { name: /In a new worktree/ }).check()
  await page.getByLabel('Branch name').fill('fix')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByRole('alert').filter({ hasText: `Folder ${never} doesn't exist` })).toBeVisible()
  await expect(page.getByLabel('Branch name')).not.toHaveAttribute('aria-invalid')
  await expect(page.getByText(/rev-parse|no such file/)).toHaveCount(0)

  // A start that goes through takes back an earlier start error.
  await page.getByRole('checkbox', { name: /In a new worktree/ }).uncheck()
  await page.route('**/api/sessions', (route) => (route.request().method() === 'POST' ? route.fulfill({ status: 500, body: 'database is locked' }) : route.continue()))
  const here = newFolder(`here-${info.project.name}`)
  await field.fill(here)
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.locator('.toast-error', { hasText: 'database is locked' })).toBeVisible()
  await page.unroute('**/api/sessions')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByLabel('Message')).toBeVisible()
  await expect(page.locator('.toast-error')).toHaveCount(0)
})

test('the switcher offers no new session in a gone folder and keeps [current] whole', async ({ page, isMobile }, info) => {
  test.skip(isMobile, 'the switcher is a keyboard affordance')
  const cwd = newFolder(`switch-gone-${info.project.name}`)
  const made = (await (await page.request.post('/api/sessions', { headers, data: { agent: 'claude', cwd } })).json()) as { id: string }
  await page.request.post(`/api/sessions/${made.id}/title`, { headers, data: { title: `a very long title that goes on and on and on and on and on and on and on and on ${info.project.name}` } })
  rmSync(cwd, { recursive: true, force: true })
  await page.goto(`/s/${made.id}?token=${token}`)
  await expect(page.getByRole('group', { name: 'Folder gone' })).toBeVisible()
  await page.locator('.chat-header').click()
  await page.keyboard.press('ControlOrMeta+k')
  const dialog = page.getByRole('dialog')
  const input = dialog.getByRole('combobox', { name: 'Go to' })
  await expect(dialog.locator('.switcher-current')).toBeVisible()
  const tag = dialog.locator('.switcher-current')
  expect(await tag.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().right <= el.closest('.switcher-title')!.getBoundingClientRect().right + 1)).toBe(true)
  await expect(dialog.getByRole('option', { name: /New (Claude|Codex) session in/ })).toHaveCount(0)
  await input.fill(`new claude switch-gone-${info.project.name}`)
  await expect(dialog.getByRole('option', { name: /New (Claude|Codex) session in/ })).toHaveCount(0)
})
