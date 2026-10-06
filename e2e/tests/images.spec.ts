import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import { token } from '../playwright.config'
import { openNewSession, showPane } from './pane'

// A 1x1 transparent PNG.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

async function newSession(page: Page, agent: 'Claude' | 'Codex') {
  const dir = fs.realpathSync(fs.mkdtempSync(`${os.tmpdir()}/gc-img-`))
  await showPane(page, 'Sessions')
  await openNewSession(page)
  await page.getByRole('radio', { name: agent }).click()
  await page.getByLabel('Working directory').fill(dir)
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByLabel('Message')).toBeVisible()
}

for (const agent of ['Claude', 'Codex'] as const) {
  test(`sends an attached image to ${agent}`, async ({ page }) => {
    await page.goto(`/?token=${token}`)
    await newSession(page, agent)
    await page.getByLabel('Attach images').setInputFiles({ name: 'dot.png', mimeType: 'image/png', buffer: png })
    const chip = page.locator('.attachment img')
    await expect(chip).toBeVisible()
    await expect.poll(() => chip.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1)

    await page.getByLabel('Message').fill('describe')
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(page.locator('.item.assistant', { hasText: /\[image (image\/png )?\d+ bytes\] describe/ })).toBeVisible()
    await expect(page.locator('.item.user img')).toBeVisible()
    await expect(chip).toHaveCount(0)
  })
}
