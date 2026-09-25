import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import { token } from '../playwright.config'
import { showPane } from './pane'

// A real shell (SHELL=/bin/sh from the webServer command) in a pty.
test('independent terminal: run a command, survive reload, exit, close', async ({ page }) => {
  const dir = fs.realpathSync(fs.mkdtempSync(`${os.tmpdir()}/gc-term-`))
  await page.goto(`/?token=${token}`)
  await showPane(page, 'Terminal')
  const panel = page.getByRole('region', { name: 'Terminals' })
  await panel.getByLabel('terminal directory').fill(dir)
  await panel.getByRole('button', { name: 'New terminal' }).click()

  const tab = panel.getByRole('tab', { selected: true })
  await expect(tab).toHaveText(dir.split('/').pop()!)
  const screen = panel.getByTestId('terminal-view')
  await screen.click()
  await page.keyboard.type('echo "hello-$((40+2)) in $(pwd)"\n')
  await expect(screen.locator('.xterm-rows')).toContainText(`hello-42 in ${dir}`)

  // A device-attributes query in the scrollback. The live answer
  // (ESC[?1;2c) is consumed by read; replaying the query after reload must
  // not type a second answer into the shell.
  await page.keyboard.type("printf '\\033[c'; read -rs -t 2 -d c; echo query-sent\n")
  await expect(screen.locator('.xterm-rows')).toContainText('query-sent')
  await page.keyboard.type('echo before-$((1+1))\n')
  await expect(screen.locator('.xterm-rows')).toContainText('before-2')
  await expect(screen.locator('.xterm-rows')).not.toContainText('1;2c')

  await page.reload()
  await showPane(page, 'Terminal')
  // Tests run in parallel against one server: pick our own terminal.
  await panel.getByRole('tab', { name: dir.split('/').pop() }).click()
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
  await expect(panel.getByRole('tab')).toHaveCount(0)
})

test('terminal in the session directory', async ({ page }) => {
  const dir = fs.realpathSync(fs.mkdtempSync(`${os.tmpdir()}/gc-sess-`))
  await page.goto(`/?token=${token}`)
  await page.getByLabel('working directory').fill(dir)
  await page.getByRole('button', { name: 'New session' }).click()
  await expect(page.getByLabel('message')).toBeVisible()

  const panel = page.getByRole('region', { name: 'Terminals' })
  await showPane(page, 'Terminal')
  await panel.getByRole('button', { name: 'In session dir' }).click()
  const screen = panel.getByTestId('terminal-view')
  await screen.click()
  await page.keyboard.type('pwd\n')
  await expect(screen.locator('.xterm-rows')).toContainText(dir)
  await panel.getByRole('button', { name: `Close terminal ${dir.split('/').pop()}` }).click()
})
