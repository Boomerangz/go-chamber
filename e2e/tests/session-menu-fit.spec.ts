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

// placing reads the row and its sheet in one go: other workers' sessions
// move the list at any moment (the sheet catches up on the next frame), and
// two separate reads can straddle such a move.
function placing(page: Page, name: string) {
  return page.getByRole('button', { name: `Actions for ${name}` }).evaluate((trigger) => {
    const row = trigger.parentElement!.getBoundingClientRect()
    const sheet = document.querySelector('.session-menu')!.getBoundingClientRect()
    return {
      rowY: row.y,
      overlap: Math.min(row.bottom, sheet.bottom) - Math.max(row.top, sheet.top),
      // right under the row, or right over it (SessionMenu keeps 2px between)
      beside: Math.abs(sheet.top - row.bottom - 2) < 1 || Math.abs(row.top - sheet.bottom - 2) < 1,
    }
  })
}

// The question sits beside the row it asks about, not over it.
test('the delete question leaves its own row in view', async ({ page }, info) => {
  const name = `row in view ${info.project.name}`
  await namedSession(page, name)
  await askDelete(page, name)
  await expect.poll(async () => (await placing(page, name)).overlap).toBeLessThanOrEqual(0)
})

// Sessions started elsewhere (another tab, another device) join the list
// while the question is open and move its row without any scroll: the
// question moves with the row instead of staying where the row was.
test('the delete question keeps beside its row when the list changes under it', async ({ page }, info) => {
  const name = `row moved ${info.project.name}`
  await namedSession(page, name)
  await askDelete(page, name)
  await expect.poll(async () => (await placing(page, name)).beside).toBe(true)
  const before = (await placing(page, name)).rowY
  const headers = { Authorization: `Bearer ${token}` }
  const cwd = fs.realpathSync(fs.mkdtempSync(`${os.tmpdir()}/gc-menufit-other-`))
  const created = await page.request.post('/api/sessions', { headers, data: { agent: 'claude', cwd } })
  const { id } = (await created.json()) as { id: string }
  expect((await page.request.post(`/api/sessions/${id}/messages`, { headers, data: { text: 'hello' } })).ok()).toBeTruthy()
  await expect.poll(async () => (await placing(page, name)).rowY).not.toBe(before)
  await expect(page.getByRole('group', { name: `Delete ${name}?` })).toBeVisible()
  await expect.poll(async () => (await placing(page, name)).beside).toBe(true)
})
