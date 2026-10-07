import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import { token } from '../playwright.config'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'RTCPeerConnection', { value: undefined }))
})

// open starts a shell in dir through the API, so nothing is attached yet.
async function open(page: Page, dir: string) {
  const res = await page.request.post('/api/terminals', { data: { cwd: dir } })
  expect(res.ok()).toBe(true)
  return (await res.json()) as { id: string; title: string }
}

test('shells in one folder are numbered, and a phone with nothing attached shows the whole list', async ({ page }, info) => {
  const dir = fs.realpathSync(fs.mkdtempSync(`${os.tmpdir()}/gc-list-`))
  const name = dir.split('/').pop()!
  await page.goto(`/?token=${token}`)
  const opened = [await open(page, dir), await open(page, dir), await open(page, dir)]
  expect(opened.map((t) => t.title)).toEqual([name, `${name} 2`, `${name} 3`])
  await page.reload()

  await page.getByRole('radio', { name: /^Terminal/ }).click()
  const panel = page.getByRole('region', { name: 'Terminals' })
  const list = panel.getByRole('tablist')
  await expect(list.getByRole('tab', { name: new RegExp(`${name} 3`) })).toBeVisible()
  if (info.project.name === 'mobile') {
    // Nothing attached: no hero, and the list is not cut short.
    await expect(panel.getByText('Pick a terminal to attach.')).toBeHidden()
    const sidebar = panel.locator('.term-sidebar')
    const height = await sidebar.evaluate((el) => el.getBoundingClientRect().height)
    expect(height).toBeGreaterThan(page.viewportSize()!.height * 0.5)
    for (const t of opened) await expect(list.getByRole('tab', { name: new RegExp(`^${t.title} /`) })).toBeVisible()
  }
  for (const t of opened) await page.request.delete(`/api/terminals/${t.id}`)
})

test('diagnostics fit the terminal table on a laptop and fold idle shells into a line', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', 'laptop width')
  await page.setViewportSize({ width: 1440, height: 900 })
  const dir = fs.realpathSync(fs.mkdtempSync(`${os.tmpdir()}/gc-diag-`))
  await page.goto(`/?token=${token}`)
  const idle = await open(page, dir)
  await page.reload()
  await page.getByRole('radio', { name: /^Terminal/ }).click()
  const panel = page.getByRole('region', { name: 'Terminals' })
  await panel.getByLabel('Terminal folder').fill(dir)
  await panel.getByRole('button', { name: 'New terminal' }).click()
  await expect(panel.getByTestId('terminal-view')).toBeVisible()
  await page.getByRole('radio', { name: /^Diagnostics/ }).click()
  const table = page.locator('.diagnostics-table-wrap')
  await expect(table.getByRole('rowheader').first()).toBeVisible()
  expect(await table.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  await expect(page.locator('.diagnostics-idle')).toContainText(idle.title)
  await page.request.delete(`/api/terminals/${idle.id}`)
})
