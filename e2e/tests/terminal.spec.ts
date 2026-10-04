import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import { token } from '../playwright.config'

// Transport upgrades have their own scenarios in terminal-rtc.spec.ts.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'RTCPeerConnection', { value: undefined }))
})

// A real shell (SHELL=/bin/sh from the webServer command) in a pty.
test('independent terminal: run a command, survive reload, exit, close', async ({ page }) => {
  const dir = fs.realpathSync(fs.mkdtempSync(`${os.tmpdir()}/gc-term-`))
  await page.goto(`/?token=${token}`)
  await page.getByRole('radio', { name: /^Terminal/ }).click()
  const panel = page.getByRole('region', { name: 'Terminals' })
  await expect(page.getByRole('heading', { name: 'Start a session' })).toBeHidden()
  await panel.getByLabel('terminal directory').fill(dir)
  await panel.getByRole('button', { name: 'New terminal' }).click()

  const tab = panel.getByRole('tab', { selected: true })
  await expect(tab).toContainText(dir.split('/').pop()!)
  await expect(tab).toContainText(dir)
  const screen = panel.getByTestId('terminal-view')
  await screen.click()
  await page.keyboard.type('echo "hello-$((40+2)) in $(pwd)"\n')
  await expect(screen.locator('.xterm-rows')).toContainText(`hello-42 in ${dir}`)

  // A device-attributes query in the scrollback. The live answer
  // (ESC[?1;2c) is consumed by read; replaying the query after reload must
  // not type a second answer into the shell.
  // Compute the marker so the echoed command cannot satisfy the wait while
  // read is still consuming the terminal's device-attributes response.
  await page.keyboard.type("printf '\\033[c'; read -rs -t 2 -d c; echo query-$((40+2))\n")
  await expect(screen.locator('.xterm-rows')).toContainText('query-42')
  await page.keyboard.type('echo before-$((1+1))\n')
  await expect(screen.locator('.xterm-rows')).toContainText('before-2')
  await expect(screen.locator('.xterm-rows')).not.toContainText('1;2c')

  // Terminal mode survives a reload.
  await page.reload()
  await expect(page.getByRole('radio', { name: /^Terminal/ })).toHaveAttribute('aria-checked', 'true')
  // Tests run in parallel against one server: pick our own terminal.
  await panel.getByRole('tab', { name: new RegExp(dir.split('/').pop()!) }).click()
  const rows = panel.getByTestId('terminal-view').locator('.xterm-rows')
  await expect(rows).toContainText(`hello-42 in ${dir}`)
  await panel.getByTestId('terminal-view').click()
  await page.keyboard.type('echo after-$((2+3))\n')
  await expect(rows).toContainText('after-5')
  await expect(rows).not.toContainText('1;2c')

  await panel.getByTestId('terminal-view').click()
  await page.keyboard.type('exit 5\n')
  await expect(panel.getByTestId('terminal-view').locator('.xterm-rows')).toContainText('process exited with code 5')
  await expect(panel.getByRole('tab', { selected: true })).toContainText('exited 5')

  await panel.getByRole('button', { name: `Close terminal ${dir.split('/').pop()}` }).click()
  await expect(panel.getByRole('tab', { name: new RegExp(dir.split('/').pop()!) })).toHaveCount(0)
  await page.getByRole('radio', { name: 'Agents' }).click()
  await expect(page.getByRole('button', { name: 'New session', exact: true })).toBeVisible()
})

test('terminal in the session directory', async ({ page }) => {
  const dir = fs.realpathSync(fs.mkdtempSync(`${os.tmpdir()}/gc-sess-`))
  await page.goto(`/?token=${token}`)
  await page.getByLabel('working directory').fill(dir)
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByLabel('message')).toBeVisible()

  const panel = page.getByRole('region', { name: 'Terminals' })
  await page.getByRole('radio', { name: /^Terminal/ }).click()
  await panel.getByRole('button', { name: `Open terminal in ${dir.split('/').pop()}` }).click()
  const screen = panel.getByTestId('terminal-view')
  await screen.click()
  await page.keyboard.type('pwd\n')
  await expect(screen.locator('.xterm-rows')).toContainText(dir)
  await panel.getByRole('button', { name: `Close terminal ${dir.split('/').pop()}` }).click()
})

test('ad-hoc terminal docked next to the chat', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the dock is desktop-only; phones use terminal mode')
  const dir = fs.realpathSync(fs.mkdtempSync(`${os.tmpdir()}/gc-dock-`))
  await page.goto(`/?token=${token}`)
  await page.getByLabel('working directory').fill(dir)
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByLabel('message')).toBeVisible()

  // Collapsed by default: only the rail shows.
  const rail = page.getByRole('toolbar', { name: 'Dock' })
  const panel = page.getByRole('region', { name: 'Terminals' })
  await expect(panel).toBeHidden()
  await rail.getByRole('button', { name: /^Terminal/ }).click()
  await panel.getByRole('button', { name: 'In session dir' }).click()
  const screen = panel.getByTestId('terminal-view')
  await screen.click()
  await page.keyboard.type('pwd\n')
  await expect(screen.locator('.xterm-rows')).toContainText(dir)
  await expect(page.getByLabel('message')).toBeVisible()

  await rail.getByRole('button', { name: 'Collapse dock' }).click()
  await expect(panel).toBeHidden()
  await rail.getByRole('button', { name: /^Terminal/ }).click()
  await panel.getByRole('button', { name: `Close terminal ${dir.split('/').pop()}` }).click()
})
