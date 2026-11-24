import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import { token } from '../playwright.config'
import { showPane, showShells } from './pane'

test('Settings pick the terminal font from the ones this browser has, and keep it', async ({ page }) => {
  const dir = fs.realpathSync(fs.mkdtempSync(`${os.tmpdir()}/gc-term-font-`))
  await page.goto(`/?token=${token}`)
  await showPane(page, 'Sessions')
  await page.getByRole('button', { name: 'Settings' }).click()
  const select = page.getByRole('combobox', { name: 'Terminal font' })
  await expect(select).toHaveValue('')
  // Whichever fixed-width font this machine offers first.
  const family = await select.locator('option').nth(1).getAttribute('value')
  expect(family).toBeTruthy()
  await select.selectOption(family)
  await page.keyboard.press('Escape')

  await page.getByRole('radio', { name: /^Terminal/ }).click()
  const panel = page.getByRole('region', { name: 'Terminals' })
  await panel.getByLabel('Terminal folder').fill(dir)
  await panel.getByRole('button', { name: 'New terminal' }).click()
  const rows = panel.getByTestId('terminal-view').locator('.xterm-rows')
  const font = () => rows.evaluate((el) => getComputedStyle(el).fontFamily)
  await expect.poll(font).toMatch(new RegExp(`^"?${family}"?,`))
  // The terminal keeps the system's smoothing; the page around it doesn't.
  const smoothing = (el: Element) => getComputedStyle(el).getPropertyValue('-webkit-font-smoothing')
  expect(await rows.evaluate(smoothing)).toBe('auto')
  expect(await page.locator('body').evaluate(smoothing)).toBe('antialiased')

  await page.reload()
  await showShells(page)
  await panel.getByRole('tab', { name: new RegExp(dir.split('/').pop()!) }).click()
  await expect.poll(font).toMatch(new RegExp(`^"?${family}"?,`))
  await showShells(page)
  await panel.getByRole('button', { name: `Close terminal ${dir.split('/').pop()}` }).click()
  await panel.getByRole('group', { name: /^Close terminal / }).getByRole('button', { name: 'Close', exact: true }).click()
})
