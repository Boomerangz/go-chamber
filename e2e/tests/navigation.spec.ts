import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { token } from '../playwright.config'
import { openNewSession, showPane } from './pane'

// startIn starts a session in cwd and sends text; with fail the server
// refuses the message, which raises a failure notice. (A folder gone under
// the session is said in the composer's place instead: folder-gone.spec.)
async function startIn(page: Page, cwd: string, text: string, { fail = false } = {}) {
  mkdirSync(cwd, { recursive: true })
  await showPane(page, 'Sessions')
  await openNewSession(page)
  await page.getByLabel('Working directory').fill(cwd)
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  // On a phone the folder sits behind the header's "⋯"; it is there all the same.
  await expect(page.locator('.chat-path', { hasText: cwd })).toBeAttached()
  if (fail) await page.route('**/api/sessions/*/messages', (route) => route.fulfill({ status: 500, body: 'agent unavailable' }))
  await page.getByLabel('Message').fill(text)
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
  await expect(page.getByText('Sign out?').filter({ visible: true })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).filter({ visible: true }).click()
  await expect(health).toBeVisible()
})

test('a new session starts in the open folder, offers recent ones and says when one is missing', async ({ page }, info) => {
  const cwd = `/tmp/nav-${info.project.name}-${Date.now()}`
  await page.goto(`/?token=${token}`)
  await startIn(page, cwd, 'hello folder')
  await expect(page.getByText('echo: hello folder')).toBeVisible()
  await showPane(page, 'Sessions')
  await openNewSession(page)
  const field = page.getByLabel('Working directory')
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
  // On a phone the folder sits behind the header's "⋯"; it is there all the same.
  await expect(page.locator('.chat-path', { hasText: cwd })).toBeAttached()
})

test('on a phone, Back from a chat returns to the list and notices stay clear of the composer', async ({ page, isMobile }, info) => {
  test.skip(!isMobile, 'phones only')
  const cwd = `/tmp/back-${info.project.name}-${Date.now()}`
  await page.goto(`/?token=${token}`)
  await startIn(page, cwd, 'phone back')
  await expect(page.getByText('echo: phone back')).toBeVisible()
  await showPane(page, 'Sessions')
  await page.locator('button.session', { hasText: 'phone back' }).first().click()
  await expect(page.getByLabel('Message')).toBeVisible()
  await page.goBack()
  await expect(page.locator('.sidebar')).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: /^Sessions/ })).toHaveAttribute('aria-pressed', 'true')

  // A failure notice sits over the transcript: under the chat header, above the composer.
  await startIn(page, `/tmp/missing-${info.project.name}-${Date.now()}`, 'nowhere', { fail: true })
  const toast = page.locator('.toast-error').first()
  await expect(toast).toBeVisible()
  const composer = await page.locator('.composer').boundingBox()
  const box = await toast.boundingBox()
  const header = await page.locator('.chat-header').boundingBox()
  expect(box!.y).toBeGreaterThanOrEqual(header!.y + header!.height - 1)
  expect(box!.y + box!.height).toBeLessThan(composer!.y)
})

test('Back from the first session opened at / leaves it, and stays left', async ({ page, isMobile }, info) => {
  const cwd = `/tmp/first-${info.project.name}-${Date.now()}`
  await page.goto(`/?token=${token}`)
  await startIn(page, cwd, 'first back')
  await expect(page.getByText('echo: first back')).toBeVisible()
  await expect(page).toHaveURL(/\/s\//)
  await page.goBack()
  if (isMobile) {
    await expect(page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: /^Sessions/ })).toHaveAttribute('aria-pressed', 'true')
  } else {
    await expect(page).toHaveURL(/\/\?token=|\/$/)
    await expect(page.getByRole('heading', { name: 'Start a session' })).toBeVisible()
  }
  // A later change in the app must not push the session back.
  const steps = await page.evaluate(() => history.length)
  await page.getByLabel('Search sessions').fill('first back')
  await page.getByLabel('Search sessions').fill('')
  expect(await page.evaluate(() => history.length)).toBe(steps)
  if (isMobile) await expect(page.locator('.sidebar')).toBeVisible()
  else await expect(page.getByRole('heading', { name: 'Start a session' })).toBeVisible()
})

test('the sessions list never scrolls sideways, and its row menu clears the request count', async ({ page, isMobile }, info) => {
  const long = `/tmp/a-folder-with-a-very-long-name-that-would-stretch-the-list-${info.project.name}-${Date.now()}`
  await page.goto(`/?token=${token}`)
  await startIn(page, long, `wide ${info.project.name}: please permission`)
  await expect(page.locator('.request-title', { hasText: 'Run command' })).toBeVisible()
  await showPane(page, 'Sessions')
  const list = page.locator('.sidebar-body')
  await expect(list.locator('.group-name', { hasText: 'a-folder-with-a-very-long-name' }).first()).toBeVisible()
  const sizes = await list.evaluate((el) => {
    const groups = el.querySelector('.groups')!
    return { scroll: groups.scrollWidth, client: groups.clientWidth, bodyScroll: el.scrollWidth, bodyClient: el.clientWidth }
  })
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.client)
  expect(sizes.bodyScroll).toBeLessThanOrEqual(sizes.bodyClient)

  const row = list.locator('li', { has: page.locator('button.session', { hasText: `wide ${info.project.name}` }) }).first()
  await row.locator('button.session').hover()
  const count = await row.locator('.session-meta .badge').boundingBox()
  const trigger = await row.locator('.session-menu-trigger').boundingBox()
  const sidebar = await page.locator('.sidebar').boundingBox()
  expect(count).not.toBeNull()
  // The menu button stays inside the sidebar and off the count.
  expect(trigger!.x + trigger!.width).toBeLessThanOrEqual(sidebar!.x + sidebar!.width)
  const overlaps = count!.x < trigger!.x + trigger!.width && trigger!.x < count!.x + count!.width && count!.y < trigger!.y + trigger!.height && trigger!.y < count!.y + count!.height
  expect(overlaps).toBe(false)
  if (isMobile) return

  // Archived and History open below the list without squeezing it.
  const before = (await page.locator('.groups').boundingBox())!.height
  const history = page.locator('details.history', { hasText: 'History' }).last()
  await history.locator('summary').click()
  await expect(history).toHaveAttribute('open', '')
  expect((await page.locator('.groups').boundingBox())!.height).toBeGreaterThanOrEqual(before - 1)
})

test('a failure notice covers no control: not the header, the dock rail, the composer or the folder field', async ({ page, isMobile }, info) => {
  await page.goto(`/?token=${token}`)
  await startIn(page, `/tmp/notice-${info.project.name}-${Date.now()}`, 'notice place')
  await expect(page.getByText('echo: notice place')).toBeVisible()
  await startIn(page, `/tmp/missing-${info.project.name}-${Date.now()}`, 'nowhere', { fail: true })
  const toast = page.locator('.toast-error').first()
  await expect(toast).toBeVisible()
  const box = (await toast.boundingBox())!
  const clear = async (selector: string) => {
    const other = await page.locator(selector).first().boundingBox()
    if (!other) return
    const overlaps = box.x < other.x + other.width && other.x < box.x + box.width && box.y < other.y + other.height && other.y < box.y + box.height
    expect(overlaps, `notice over ${selector}`).toBe(false)
  }
  await clear('.chat-header')
  await clear('.composer')
  if (!isMobile) await clear('.dock-rail')
  // The stack takes no clicks outside its notices.
  expect(await page.locator('.notices').evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none')
  if (isMobile) {
    // On the list the notice sits above the pane bar, off the folder field.
    await showPane(page, 'Sessions')
    await openNewSession(page)
    const moved = (await toast.boundingBox())!
    const field = (await page.locator('.new-session .folder-field').boundingBox())!
    expect(moved.y).toBeGreaterThan(field.y + field.height)
  }
})

// Chromium draws nothing in an input scrolled to its end while it also
// ellipsizes, so a picked project path looked blank.
test('a long folder path shows its end, not a blank field', async ({ page }) => {
  const long = `/tmp/a-rather-long-parent-folder/${'nested/'.repeat(4)}the-project`
  mkdirSync(long, { recursive: true })
  await page.goto(`/?token=${token}`)
  await showPane(page, 'Sessions')
  await openNewSession(page)
  const field = page.getByLabel('Working directory')
  await field.fill(long)
  await field.blur()
  await expect(field).toHaveValue(long)
  const shown = await field.evaluate((el: HTMLInputElement) => ({
    overflow: getComputedStyle(el).textOverflow,
    atEnd: el.scrollLeft > 0 && Math.abs(el.scrollLeft + el.clientWidth - el.scrollWidth) <= 2,
  }))
  expect(shown).toEqual({ overflow: 'clip', atEnd: true })
})
