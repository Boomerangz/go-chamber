import { expect, test, type Locator } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import { token } from '../playwright.config'
import { openNewSession } from './pane'

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
