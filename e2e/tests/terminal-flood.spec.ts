import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { token } from '../playwright.config'

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'RTCPeerConnection', { value: undefined }))
})

const running = (marker: string) => {
  try {
    return execFileSync('pgrep', ['-f', marker]).toString().trim() !== ''
  } catch {
    return false // pgrep exits 1 when nothing matches
  }
}

// A slower client used to be dropped for lagging about every second and
// reconnect with a growing backoff, and the Ctrl-C typed meanwhile waited
// behind the replay: `yes` kept running for a minute. Now the client is
// resynced on the same socket and its typing goes out at once.
test('Ctrl-C stops a flooding command on a slow client, without reconnecting', async ({ page, context, browserName, isMobile }) => {
  test.skip(browserName !== 'chromium' || isMobile, 'CPU throttling is a desktop Chromium feature')
  const dir = fs.realpathSync(fs.mkdtempSync(`${os.tmpdir()}/gc-flood-`))
  const marker = `FLOOD-${Date.now().toString(36)}`
  const sockets: string[] = []
  page.on('websocket', (ws) => {
    if (ws.url().includes('/pty')) sockets.push(ws.url())
  })
  await page.goto(`/?token=${token}`)
  await page.getByRole('radio', { name: /^Terminal/ }).click()
  const panel = page.getByRole('region', { name: 'Terminals' })
  await panel.getByLabel('Terminal folder').fill(dir)
  await panel.getByRole('button', { name: 'New terminal' }).click()
  const screen = panel.getByTestId('terminal-view')
  await screen.click()
  await page.keyboard.type('echo READY-$((1+1))\n')
  await expect(screen.locator('.xterm-rows')).toContainText('READY-2')

  const cdp = await context.newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  try {
    await page.keyboard.insertText(`yes "${marker} a fairly long line of output to fill the terminal quickly 0123456789"`)
    await page.keyboard.press('Enter')
    await expect.poll(() => running(marker)).toBe(true)
    await page.waitForTimeout(2000)
    await page.keyboard.press('Control+c')
    await expect.poll(() => running(marker), { timeout: 10_000 }).toBe(false)
  } finally {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
  }
  expect(sockets).toHaveLength(1)
})
