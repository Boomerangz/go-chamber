import { expect, test, type Locator } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import { token } from '../playwright.config'
import { openNewSession, showPane } from './pane'

// Long names in the shell around the chat: they shorten on one line inside
// their own box and never push past it.

const longName = `payments-gateway-service-with-an-extraordinarily-long-directory-name`

async function box(l: Locator) {
  const b = await l.boundingBox()
  if (!b) throw new Error('not rendered')
  return b
}

async function startSession(page: import('@playwright/test').Page, cwd: string) {
  await page.goto(`/?token=${token}`)
  await openNewSession(page)
  await page.getByLabel('Working directory').fill(cwd)
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByLabel('message')).toBeVisible()
}

test('a project chip shows its icon beside a shortened name, inside the list', async ({ page }) => {
  const dir = fs.realpathSync(fs.mkdtempSync(`${os.tmpdir()}/gc-fit-`))
  const cwd = `${dir}/${longName}`
  fs.mkdirSync(cwd)
  await startSession(page, cwd)
  await page.getByRole('radio', { name: /^Terminal/ }).click()
  const sidebar = page.locator('.term-sidebar')
  const chip = sidebar.getByRole('button', { name: `Open terminal in ${longName}` })
  const label = chip.locator('.chip-label')
  await expect(label).toBeVisible()
  const [c, l, i, s] = await Promise.all([box(chip), box(label), box(chip.locator('svg')), box(sidebar)])
  // the name is on the icon's line, not under it
  expect(Math.abs(l.y + l.height / 2 - (i.y + i.height / 2))).toBeLessThan(3)
  expect(l.width).toBeGreaterThan(40)
  // shortened, and the chip stays inside the list
  expect(await label.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true)
  expect(c.x + c.width).toBeLessThanOrEqual(s.x + s.width)
})

test('the dock lists every shell under ▾ and attaches the one picked', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the dock is desktop-only')
  await page.addInitScript(() => Object.defineProperty(window, 'RTCPeerConnection', { value: undefined }))
  const dir = fs.realpathSync(fs.mkdtempSync(`${os.tmpdir()}/gc-dockall-`))
  await startSession(page, dir)
  await page.getByRole('toolbar', { name: 'Dock' }).getByRole('button', { name: /^Terminal/ }).click()
  const panel = page.getByRole('region', { name: 'Terminals' })
  await panel.getByRole('button', { name: 'New terminal in session dir' }).click()
  await expect(panel.getByRole('tab', { selected: true })).toBeVisible()
  await panel.getByRole('button', { name: 'New terminal in session dir' }).click()
  const name = dir.split('/').pop()!
  // the second shell's title names the folder: it isn't repeated beside it
  await expect(panel.getByRole('tab', { name: new RegExp(`${name} 2`) }).locator('.term-tab-cwd')).toHaveCount(0)
  await panel.getByRole('button', { name: 'More terminals' }).click()
  const all = panel.getByRole('group', { name: 'All terminals' })
  await expect(all.getByRole('button', { name: new RegExp(`^${name} 2`) })).toHaveAttribute('aria-current', 'true')
  await all.getByRole('button', { name: new RegExp(`^${name}$`) }).click()
  await expect(all).toBeHidden()
  await expect(panel.getByRole('tab', { selected: true })).toHaveAccessibleName(new RegExp(`^${name}$`))
  for (const t of [`${name} 2`, name]) {
    await panel.getByRole('button', { name: `Close terminal ${t}`, exact: true }).click()
    await panel.getByRole('group', { name: /^Close terminal / }).getByRole('button', { name: 'Close', exact: true }).click()
  }
})

test('a session opened by its link is in view in the list, also on a phone', async ({ page }) => {
  const dir = fs.realpathSync(fs.mkdtempSync(`${os.tmpdir()}/gc-link-`))
  const headers = { Authorization: `Bearer ${token}` }
  const create = async (cwd: string) => {
    fs.mkdirSync(cwd, { recursive: true })
    const r = await page.request.post('/api/sessions', { headers, data: { agent: 'claude', cwd } })
    return ((await r.json()) as { id: string }).id
  }
  // the oldest of a full group, below a long list of other folders
  const target = await create(`${dir}/zz-target`)
  for (let i = 0; i < 7; i++) await create(`${dir}/zz-target`)
  for (let i = 0; i < 24; i++) await create(`${dir}/other-${i}`)
  await page.goto(`/?token=${token}`)
  await page.goto(`/s/${target}`)
  await showPane(page, 'Sessions')
  const row = page.locator('.sidebar button.session[aria-current="true"]')
  await expect(row).toBeInViewport({ ratio: 0.9 })
  const bar = page.getByRole('navigation', { name: 'Views' })
  if (await bar.isVisible()) expect((await box(row)).y + (await box(row)).height).toBeLessThanOrEqual((await box(bar)).y + 1)
})

test('unreachable accounts and quotas are said once, in place, with one Retry', async ({ page }) => {
  let down = true
  const fail = (route: import('@playwright/test').Route) => (down ? route.fulfill({ status: 500, body: 'down' }) : route.fallback())
  await page.route('**/api/account?*', fail)
  await page.route('**/api/quotas', fail)
  await page.goto(`/?token=${token}`)
  await showPane(page, 'Sessions')
  const footer = page.locator('.sidebar-footer')
  await expect(footer.getByRole('alert')).toHaveText(/Couldn't reach the accounts/)
  await expect(footer.getByRole('alert')).toHaveCount(1)
  await expect(page.locator('.notices')).toHaveCount(0)
  down = false
  await footer.getByRole('button', { name: 'Retry' }).click()
  await expect(footer.getByRole('alert')).toHaveCount(0)
  await expect(footer).toContainText('Claude')
})

test('a word typed at a rail button just clicked fires no single-key shortcut', async ({ page, isMobile }) => {
  test.skip(isMobile, 'keyboard shortcuts are a desktop affordance')
  const dir = fs.realpathSync(fs.mkdtempSync(`${os.tmpdir()}/gc-stray-`))
  await startSession(page, dir)
  const requests = page.getByRole('toolbar', { name: 'Dock' }).getByRole('button', { name: /^Requests/ })
  await requests.click()
  await page.keyboard.type('fit')
  await expect(page.locator('.focus-toggle')).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('.layout')).not.toHaveAttribute('data-dock', 'terminal')
  // the keys still work from the page itself
  await page.locator('.chat-header').click({ position: { x: 4, y: 4 } })
  await page.keyboard.press('f')
  await expect(page.locator('.focus-toggle')).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('f')
})

test.describe('the narrowest phone', () => {
  test.use({ viewport: { width: 320, height: 640 } })
  test('the modes, a shell count included, fit beside the health mark', async ({ page }) => {
    const headers = { Authorization: `Bearer ${token}` }
    const opened = await page.request.post('/api/terminals', { headers, data: { cwd: os.tmpdir() } })
    const { id } = (await opened.json()) as { id: string }
    try {
      await page.goto(`/?token=${token}`)
      const modes = page.getByRole('radiogroup', { name: 'Mode' })
      await expect(modes.locator('.count')).toBeVisible()
      expect(await modes.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true)
      const [m, h] = [await box(modes), await box(page.locator('.topbar .health'))]
      expect(m.x + m.width).toBeLessThanOrEqual(h.x)
    } finally {
      await page.request.delete(`/api/terminals/${id}`, { headers })
    }
  })
})

test('the quick switcher keeps titles readable beside a long folder', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', '⌘K is a keyboard matter')
  const dir = fs.realpathSync(fs.mkdtempSync(`${os.tmpdir()}/gc-fit-`))
  const cwd = `${dir}/${longName}`
  fs.mkdirSync(cwd)
  await startSession(page, cwd)
  await page.locator('body').click({ position: { x: 1, y: 1 } })
  await page.keyboard.press('ControlOrMeta+k')
  const dialog = page.getByRole('dialog')
  const row = dialog.getByRole('option').filter({ hasText: longName }).first()
  await expect(row).toBeVisible()
  const [r, t, d] = await Promise.all([box(row), box(row.locator('.switcher-title')), box(row.locator('.switcher-detail'))])
  expect(t.width).toBeGreaterThan(r.width * 0.3)
  expect(d.width).toBeLessThanOrEqual(r.width * 0.4 + 1)
  expect(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true)
})
