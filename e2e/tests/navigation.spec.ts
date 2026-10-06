import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { token } from '../playwright.config'
import { showPane } from './pane'

async function startIn(page: Page, cwd: string, text: string, { make = true } = {}) {
  if (make) mkdirSync(cwd, { recursive: true })
  await showPane(page, 'Sessions')
  await page.getByLabel('working directory').fill(cwd)
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.locator('.chat-path', { hasText: cwd })).toBeVisible()
  await page.getByLabel('message').fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
}

test('the top bar stays quiet while online and asks before signing out', async ({ page, isMobile }) => {
  await page.goto(`/?token=${token}`)
  const health = page.getByRole('status', { name: 'online' })
  await expect(health).toBeVisible()
  await expect(health).toHaveText('')
  await expect(health).toHaveAttribute('title', /online/)
  if (!isMobile) {
    await page.getByRole('button', { name: 'Keyboard shortcuts' }).click()
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible()
    await page.keyboard.press('Escape')
  }
  await showPane(page, 'Sessions')
  await page.getByRole('button', { name: 'Sign out' }).filter({ visible: true }).click()
  await expect(page.getByText("Sign out? You'll need the access token again.").filter({ visible: true })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).filter({ visible: true }).click()
  await expect(health).toBeVisible()
})

test('a new session starts in the open folder, offers recent ones and says when one is missing', async ({ page }, info) => {
  const cwd = `/tmp/nav-${info.project.name}-${Date.now()}`
  await page.goto(`/?token=${token}`)
  await startIn(page, cwd, 'hello folder')
  await expect(page.getByText('echo: hello folder')).toBeVisible()
  await showPane(page, 'Sessions')
  const field = page.getByLabel('working directory')
  await expect(field).toHaveValue(cwd)
  const chips = page.getByRole('group', { name: 'Recent folders' })
  await expect(chips.getByRole('button', { name: cwd.split('/').pop()! })).toBeVisible()

  await field.fill('')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByText('Choose a folder first')).toBeVisible()
  await chips.getByRole('button', { name: cwd.split('/').pop()! }).click()
  await expect(field).toHaveValue(cwd)
  await expect(page.getByText('Choose a folder first')).toHaveCount(0)
})

test('the list says who waits for you and marks what changed while you looked away', async ({ page }, info) => {
  const tag = `${info.project.name}-${Date.now()}`
  const waitingIn = `/tmp/wait-${tag}`
  const text = `mark ${tag}: please permission`
  await page.goto(`/?token=${token}`)
  await startIn(page, waitingIn, text)
  await expect(page.locator('.request-title', { hasText: 'Run command' })).toBeVisible()
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', /^data:image\/svg\+xml/)

  // Look elsewhere, then answer from the tray without opening it again.
  await startIn(page, `/tmp/other-${tag}`, 'elsewhere')
  await showPane(page, 'Sessions')
  const row = page.locator(`.group-toggle[title="${waitingIn}"]`).locator('xpath=../..').locator('button.session')
  await expect(row).toContainText('waiting for you')

  const bar = page.getByRole('navigation', { name: 'Views' })
  if (await bar.isVisible()) await bar.getByRole('button', { name: /^Requests/ }).click()
  else await page.getByRole('toolbar', { name: 'Dock' }).getByRole('button', { name: /^Requests/ }).click()
  const line = page.getByRole('complementary', { name: 'Pending requests' }).getByRole('listitem').filter({ hasText: text })
  await line.getByRole('button', { name: 'Allow', exact: true }).click()
  await expect(line).toHaveCount(0)

  await showPane(page, 'Sessions')
  await expect(row.locator('.session-unseen')).toHaveText('new')
  await row.click()
  await showPane(page, 'Sessions')
  await expect(row.locator('.session-unseen')).toHaveCount(0)
})

test('the switcher starts a new session in a folder', async ({ page, isMobile }, info) => {
  test.skip(isMobile, 'the switcher is a keyboard affordance')
  const cwd = `/tmp/switch-${info.project.name}-${Date.now()}`
  await page.goto(`/?token=${token}`)
  await startIn(page, cwd, 'switch here')
  await expect(page.getByText('echo: switch here')).toBeVisible()
  await page.locator('.chat-header').click()
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('combobox', { name: 'Go to' }).fill(`new codex ${cwd.split('/').pop()}`)
  await page.getByRole('option', { name: new RegExp(`New Codex session in ${cwd.split('/').pop()}`) }).click()
  await expect(page.locator('.chat-header .avatar-codex')).toBeVisible()
  await expect(page.locator('.chat-path', { hasText: cwd })).toBeVisible()
})

test('on a phone, Back from a chat returns to the list and notices stay clear of the composer', async ({ page, isMobile }, info) => {
  test.skip(!isMobile, 'phones only')
  const cwd = `/tmp/back-${info.project.name}-${Date.now()}`
  await page.goto(`/?token=${token}`)
  await startIn(page, cwd, 'phone back')
  await expect(page.getByText('echo: phone back')).toBeVisible()
  await showPane(page, 'Sessions')
  await page.locator('button.session', { hasText: 'phone back' }).first().click()
  await expect(page.getByLabel('message')).toBeVisible()
  await page.goBack()
  await expect(page.getByLabel('working directory')).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: /^Sessions/ })).toHaveAttribute('aria-pressed', 'true')

  // A failure notice sits under the top bar, not over the composer.
  await startIn(page, `/tmp/missing-${info.project.name}-${Date.now()}`, 'nowhere', { make: false })
  const toast = page.locator('.toast-error').first()
  await expect(toast).toBeVisible()
  const composer = await page.locator('.composer').boundingBox()
  const box = await toast.boundingBox()
  const topbar = await page.locator('.topbar').boundingBox()
  expect(box!.y).toBeGreaterThanOrEqual(topbar!.y + topbar!.height - 1)
  expect(box!.y + box!.height).toBeLessThan(composer!.y)
})
