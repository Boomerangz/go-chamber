import fs from 'node:fs'
import os from 'node:os'
import { expect, test, type Page } from '@playwright/test'
import { token } from '../playwright.config'
import { openNewSession, showPane } from './pane'

const EDGE = 14

async function namedSession(page: Page, name: string) {
  await page.goto(`/?token=${token}`)
  await showPane(page, 'Sessions')
  await openNewSession(page)
  // A folder of its own: the shared /tmp group folds older rows away.
  await page.getByLabel('Working directory').fill(fs.realpathSync(fs.mkdtempSync(`${os.tmpdir()}/gc-menufit-`)))
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await page.getByRole('button', { name: 'Rename session' }).click()
  await page.getByRole('textbox', { name: 'Session name' }).fill(name)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name })).toBeVisible()
}

async function askDelete(page: Page, name: string) {
  await showPane(page, 'Sessions')
  await page.getByRole('button', { name: `Actions for ${name}` }).click()
  await page.getByRole('menu', { name }).getByRole('menuitem', { name: 'Delete…' }).click()
  const confirm = page.getByRole('group', { name: `Delete ${name}?` })
  await expect(confirm).toBeVisible()
  return confirm
}

// On a phone the delete question takes the room the screen has, inside
// its edges, instead of the width left right of the menu it replaced.
for (const width of [390, 360]) {
  test(`the delete question fits a ${width}px screen inside its edges`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 800 })
    const name = `please ask for permission to run the migration ${width} ${info.project.name}`
    await namedSession(page, name)
    const confirm = await askDelete(page, name)
    const sheet = page.locator('.session-menu')
    await expect.poll(async () => (await sheet.boundingBox())!.x + (await sheet.boundingBox())!.width).toBeLessThanOrEqual(width - EDGE + 0.5)
    const box = (await sheet.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(EDGE - 0.5)
    expect(box.width).toBeGreaterThan(260)
    // The question reads in at most four lines.
    const lines = await confirm.locator('p').first().evaluate((p) => Math.round(p.getBoundingClientRect().height / parseFloat(getComputedStyle(p).lineHeight)))
    expect(lines).toBeLessThanOrEqual(4)
  })
}

// The question sits beside the row it asks about, not over it.
test('the delete question leaves its own row in view', async ({ page }, info) => {
  const name = `row in view ${info.project.name}`
  await namedSession(page, name)
  await askDelete(page, name)
  const row = (await page.getByRole('button', { name: `Actions for ${name}` }).locator('..').boundingBox())!
  const sheet = (await page.locator('.session-menu').boundingBox())!
  const overlap = Math.min(row.y + row.height, sheet.y + sheet.height) - Math.max(row.y, sheet.y)
  expect(overlap).toBeLessThanOrEqual(0)
})
