import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { token } from '../playwright.config'
import { openNewSession, showPane } from './pane'

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }

// A repository with one commit, then a modified file and a new Makefile.
function changedRepo(): string {
  const repo = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gc-review-'))), 'app')
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env })
  fs.writeFileSync(path.join(repo, 'main.go'), 'package main\n\nfunc main() {}\n')
  execFileSync('git', ['add', '.'], { cwd: repo, env })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo, env })
  fs.writeFileSync(path.join(repo, 'main.go'), 'package main\n\nfunc main() {\n\tprintln("hi")\n}\n')
  fs.writeFileSync(path.join(repo, 'Makefile'), 'all:\n\tgo build\n')
  return repo
}

async function openChanges(page: Page) {
  const bar = page.getByRole('navigation', { name: 'Views' })
  if (await bar.isVisible()) await bar.getByRole('button', { name: /^Changes/ }).click()
  else await page.getByRole('toolbar', { name: 'Dock' }).getByRole('button', { name: 'Changes' }).click()
  return page.getByRole('region', { name: 'Changes' })
}

const isMac = (page: Page) => page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent))

test('changes read like a review: counts first, files side by side, numbered lines, view a file', async ({ page }) => {
  const repo = changedRepo()
  await page.goto(`/?token=${token}`)
  await showPane(page, 'Sessions')
  await openNewSession(page)
  await page.getByLabel('working directory').fill(repo)
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByLabel('message')).toBeVisible()

  const panel = await openChanges(page)
  await expect(panel.getByLabel('2 files, 5 added, 1 removed lines')).toHaveText('2 files +5 −1')
  await expect(panel.getByRole('button', { name: /main\.go/ })).toContainText('+3−1')
  await panel.getByRole('button', { name: 'Expand all' }).click()
  await expect(panel.locator('.diff-view')).toHaveCount(2)
  const added = panel.locator('.diff-add', { hasText: 'println' })
  await expect(added.locator('.diff-ln').nth(1)).toHaveText('4')
  await expect(added.locator('.diff-sign')).toHaveText('+')

  await panel.locator('.diff-file', { hasText: 'Makefile' }).hover()
  await panel.locator('.diff-file', { hasText: 'Makefile' }).getByRole('button', { name: 'View file' }).click()
  const viewer = page.getByRole('dialog')
  await expect(viewer).toContainText('go build')
  await viewer.getByRole('button', { name: 'Close' }).click()
  await expect(viewer).toBeHidden()
})

test('the dock stays on its rail without a session and remembers a dragged width', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', 'docks and splitters are desktop layout')
  await page.goto(`/?token=${token}`)
  const layout = page.locator('.layout')
  const changes = page.getByRole('toolbar', { name: 'Dock' }).getByRole('button', { name: 'Changes' })
  await expect(changes).toBeDisabled()
  await expect(changes).toHaveAttribute('title', 'Open a session to see its changes')
  await page.keyboard.press('d')
  await expect(layout).toHaveAttribute('data-dock', 'closed')
  await expect(changes).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByRole('button', { name: 'Collapse dock' })).toHaveCount(0)

  const terminalButton = page.getByRole('toolbar', { name: 'Dock' }).getByRole('button', { name: 'Terminal' })
  await expect(terminalButton).toHaveAttribute('title', 'Terminal (t)')

  await page.getByRole('toolbar', { name: 'Dock' }).getByRole('button', { name: 'Terminal' }).click()
  await expect(layout).toHaveAttribute('data-dock', 'terminal')
  const dock = page.locator('.dock')
  const before = (await dock.boundingBox())!.width
  const handle = page.getByRole('separator', { name: 'Resize the dock' })
  const box = (await handle.boundingBox())!
  await page.mouse.move(box.x + 2, box.y + 200)
  await page.mouse.down()
  await page.mouse.move(box.x - 80, box.y + 200, { steps: 4 })
  await page.mouse.up()
  await expect.poll(async () => Math.round((await dock.boundingBox())!.width)).toBe(Math.round(before + 82))
  await page.reload()
  await expect.poll(async () => Math.round((await page.locator('.dock').boundingBox())!.width)).toBe(Math.round(before + 82))
  await page.getByRole('separator', { name: 'Resize the dock' }).dblclick()
  await expect.poll(async () => Math.round((await page.locator('.dock').boundingBox())!.width)).toBe(Math.round(before))
  // From the keyboard the handle shows the standard focus ring.
  const focused = page.getByRole('separator', { name: 'Resize the dock' })
  await terminalButton.focus()
  for (let i = 0; i < 40 && !(await focused.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Shift+Tab')
  await expect(focused).toBeFocused()
  await expect(focused).toHaveCSS('outline-style', 'solid')

  await page.keyboard.press((await isMac(page)) ? 'Meta+b' : 'Control+b')
  await expect(layout).toHaveAttribute('data-sidebar', 'off')
  await page.getByRole('button', { name: 'Show sessions' }).click()
  await expect(layout).not.toHaveAttribute('data-sidebar', 'off')
  await page.getByRole('toolbar', { name: 'Dock' }).getByRole('button', { name: 'Terminal' }).click()
})

test.describe('terminal', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(window, 'RTCPeerConnection', { value: undefined }))
  })

  test('finds in the scrollback and sizes the font from the keyboard', async ({ page }, info) => {
    test.skip(info.project.name === 'mobile', 'keyboard shortcuts')
    const dir = fs.realpathSync(fs.mkdtempSync(`${os.tmpdir()}/gc-find-`))
    await page.goto(`/?token=${token}`)
    await page.getByRole('radio', { name: /^Terminal/ }).click()
    const panel = page.getByRole('region', { name: 'Terminals' })
    await panel.getByLabel('terminal directory').fill(dir)
    await panel.getByRole('button', { name: 'New terminal' }).click()
    const screen = panel.getByTestId('terminal-view')
    await screen.click()
    await page.keyboard.type('echo needle-$((40+2))\n')
    await expect(screen.locator('.xterm-rows')).toContainText('needle-42')
    await page.keyboard.type('echo needle-$((40+2)) again\n')
    await expect(screen.locator('.xterm-rows')).toContainText('needle-42 again')

    const mac = await isMac(page)
    await page.keyboard.press(mac ? 'Meta+f' : 'Control+Shift+F')
    const find = panel.getByRole('searchbox', { name: 'Find in terminal' })
    await expect(find).toBeFocused()
    await find.fill('needle-42')
    // The search starts from the newest output and goes up.
    await expect(panel.locator('.term-find-count')).toHaveText('2 of 2')
    // Enter goes up to the older match (xterm may re-run a search as output settles).
    await expect(async () => {
      await find.press('Enter')
      await expect(panel.locator('.term-find-count')).toHaveText('1 of 2', { timeout: 1000 })
    }).toPass()
    await find.press('Escape')
    await expect(find).toBeHidden()

    await screen.click()
    await page.keyboard.press(mac ? 'Meta+Equal' : 'Control+Equal')
    await expect.poll(() => page.evaluate(() => localStorage.getItem('gc.terminal.fontSize'))).toBe('14')
    await expect(panel.getByRole('status', { name: 'text size' })).toHaveText('14px')
    await page.keyboard.press(mac ? 'Meta+Digit0' : 'Control+Digit0')
    await expect.poll(() => page.evaluate(() => localStorage.getItem('gc.terminal.fontSize'))).toBeNull()

    // Other tests share the server: count the tabs, then expect the same.
    const tabs = await panel.getByRole('tab').count()
    await page.keyboard.type('exit\n')
    await panel.getByRole('button', { name: 'Open again here' }).click()
    await expect(panel.getByRole('tab', { selected: true })).not.toContainText('exited')
    await expect(panel.getByRole('tab')).toHaveCount(tabs)
    await expect(panel.getByRole('tab', { selected: true })).toContainText(dir.split('/').pop()!)
    await panel.getByRole('button', { name: `Close terminal ${dir.split('/').pop()}` }).click()
    await panel.getByRole('group', { name: /^Close terminal / }).getByRole('button', { name: 'Close', exact: true }).click()
  })

  test('on a phone the shell list folds to one line while a shell is attached', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'phone layout')
    const dir = fs.realpathSync(fs.mkdtempSync(`${os.tmpdir()}/gc-fold-`))
    await page.goto(`/?token=${token}`)
    await page.getByRole('radio', { name: /^Terminal/ }).click()
    const panel = page.getByRole('region', { name: 'Terminals' })
    await panel.getByLabel('terminal directory').fill(dir)
    await panel.getByRole('button', { name: 'New terminal' }).click()
    const toggle = panel.getByRole('button', { name: /^Shells/ })
    await expect(toggle).toBeVisible()
    await expect(panel.getByLabel('terminal directory')).toBeHidden()
    await toggle.click()
    await expect(panel.getByLabel('terminal directory')).toBeVisible()
    await toggle.click()
    const name = dir.split('/').pop()!
    await toggle.click()
    await panel.getByRole('button', { name: `Close terminal ${name}` }).click()
    await panel.getByRole('group', { name: /^Close terminal / }).getByRole('button', { name: 'Close', exact: true }).click()
  })
})

test('diagnostics grade each metric and copy the report', async ({ page, context }, info) => {
  test.skip(info.project.name === 'mobile', 'clipboard permission is desktop Chromium')
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto(`/?token=${token}`)
  await page.getByRole('radio', { name: /^Diagnostics/ }).click()
  await expect(page.locator('.diagnostic-metric[data-level]').first()).toBeVisible()
  await page.getByRole('button', { name: 'Copy report' }).click()
  await expect(page.getByText('Copied the report')).toBeVisible()
  expect(JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))).toHaveProperty('client')
})
