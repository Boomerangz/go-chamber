import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { token } from '../playwright.config'

// The desktop by keyboard alone: stepping through sessions, getting out of
// a terminal, the Overview, and the docks a key opens.

const headers = { Authorization: `Bearer ${token}` }
const mac = process.platform === 'darwin'

test.beforeEach(async ({ page, isMobile }) => {
  test.skip(isMobile, 'keyboard shortcuts are a desktop affordance')
  await page.addInitScript(() => Object.defineProperty(window, 'RTCPeerConnection', { value: undefined }))
})

async function session(page: Page, cwd: string): Promise<string> {
  const r = await page.request.post('/api/sessions', { headers, data: { agent: 'claude', cwd } })
  return ((await r.json()) as { id: string }).id
}

const rows = (page: Page) => page.locator('.sidebar button.session')

async function sessionOrder(page: Page): Promise<{ ids: string[]; current: number }> {
  return rows(page).evaluateAll((els) => ({
    ids: els.map((e) => e.getAttribute('data-session') ?? ''),
    current: els.findIndex((e) => e.getAttribute('aria-current') === 'true'),
  }))
}

test('j and k step through the sessions without typing into the composer', async ({ page }) => {
  for (let i = 0; i < 4; i++) await session(page, '/tmp')
  await page.goto(`/?token=${token}`)
  await rows(page).first().click()
  const composer = page.getByLabel('Message')
  await expect(composer).toBeFocused()
  // Escape leaves an idle, empty composer for the single keys.
  await page.keyboard.press('Escape')
  await expect(composer).not.toBeFocused()

  for (const key of ['j', 'j', 'j', 'k']) {
    const { ids, current } = await sessionOrder(page)
    const want = ids[Math.max(0, Math.min(ids.length - 1, current + (key === 'j' ? 1 : -1)))]!
    await page.keyboard.press(key)
    await expect(rows(page).and(page.locator('[aria-current="true"]'))).toHaveAttribute('data-session', want)
    await expect(page).toHaveURL(new RegExp(`/s/${want}`))
  }
  const { current } = await sessionOrder(page)
  expect(current).toBe(2)
  await expect(composer).toHaveValue('')
  await expect(composer).not.toBeFocused()
})

test('the keyboard gets out of a docked terminal', async ({ page }) => {
  const dir = fs.realpathSync(fs.mkdtempSync(`${os.tmpdir()}/gc-leave-`))
  const id = await session(page, dir)
  await page.goto(`/s/${id}?token=${token}`)
  const composer = page.getByLabel('Message')
  await expect(composer).toBeFocused()
  await page.keyboard.press('Escape')

  // t opens the dock and takes the focus into it: here, with no shell in
  // this folder yet, the button that opens one.
  await page.keyboard.press('t')
  const panel = page.getByRole('region', { name: 'Terminals' })
  const open = panel.getByRole('button', { name: new RegExp(`^(Open terminal in ${path.basename(dir)}|New terminal in session folder)$`) }).and(page.locator(':focus'))
  await expect(open).toHaveCount(1)
  await page.keyboard.press('Enter')
  const screen = panel.getByTestId('terminal-view')
  await expect(screen).toBeVisible()
  await screen.click()
  const shell = panel.locator('.xterm textarea')
  await expect(shell).toBeFocused()
  await page.keyboard.type('echo in-$((6*7))\n')
  await expect(screen.locator('.xterm-rows')).toContainText('in-42')

  if (mac) {
    // ⌘K and ⌘B reach the app from inside the shell; the shell gets neither.
    await page.keyboard.press('Meta+k')
    await expect(page.getByRole('combobox', { name: 'Go to' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(shell).toBeFocused()
    await page.keyboard.press('Meta+b')
    await expect(page.locator('.layout')).toHaveAttribute('data-sidebar', 'off')
    await page.keyboard.press('Meta+b')
    await expect(page.locator('.layout')).not.toHaveAttribute('data-sidebar', 'off')
    await expect(shell).toBeFocused()
  }

  // The way out goes back to the composer.
  await page.keyboard.press(mac ? 'Meta+ArrowUp' : 'Control+Shift+ArrowUp')
  await expect(composer).toBeFocused()

  if (mac) {
    // In Terminal mode too, ⌘K goes to the app.
    await page.getByRole('radio', { name: /^Terminal/ }).click()
    const full = page.getByRole('region', { name: 'Terminals' })
    await full.getByTestId('terminal-view').click()
    await page.keyboard.press('Meta+k')
    await expect(page.getByRole('combobox', { name: 'Go to' })).toBeFocused()
    await page.keyboard.press('Escape')
  }
  const shells = (await (await page.request.get('/api/terminals', { headers })).json()) as { id: string; cwd: string }[]
  for (const t of shells.filter((t) => t.cwd.startsWith(dir))) await page.request.delete(`/api/terminals/${t.id}`, { headers })
})

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }

function repo(): string {
  const dir = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gc-keys-'))), 'app')
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { env })
  for (const name of ['a.go', 'b.go']) fs.writeFileSync(path.join(dir, name), 'package main\n')
  execFileSync('git', ['add', '.'], { cwd: dir, env })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir, env })
  for (const name of ['a.go', 'b.go']) fs.writeFileSync(path.join(dir, name), `package main\n\n${'// more\n'.repeat(400)}`)
  return dir
}

test('d opens Changes on its first file, where j and k step through files', async ({ page }) => {
  const id = await session(page, repo())
  await page.goto(`/s/${id}?token=${token}`)
  await expect(page.getByLabel('Message')).toBeFocused()
  await page.keyboard.press('Escape')
  await page.keyboard.press('d')
  const panel = page.getByRole('region', { name: 'Changes' })
  const files = panel.locator('.diff-file-toggle')
  await expect(files.first()).toBeFocused()
  await page.keyboard.press('j')
  await expect(files.nth(1)).toBeFocused()
  await expect(page).toHaveURL(new RegExp(`/s/${id}`))

  // At 1280 the header keeps one line: the time gives way to the buttons.
  const head = panel.locator('.diff-head')
  await expect(head.locator('.diff-total')).toBeVisible()
  const title = (await head.locator('.section-title').boundingBox())!
  const actions = (await head.locator('.diff-actions').boundingBox())!
  expect(Math.abs(actions.y + actions.height / 2 - (title.y + title.height / 2))).toBeLessThan(6)
  await page.keyboard.press('d')
  await expect(panel).toHaveCount(0)
})

test('o opens the Overview, its focused row is framed whole, and Escape leaves it', async ({ page }) => {
  const tag = `keys overview ${Date.now().toString(36)}`
  const id = await session(page, '/tmp')
  await page.request.post(`/api/sessions/${id}/messages`, { headers, data: { text: `${tag}: please permission` } })
  await page.goto(`/s/${id}?token=${token}`)
  await expect(page.locator('.request-title', { hasText: 'Run command' })).toBeVisible()
  // The card took the focus on arrival; o works from there.
  await page.keyboard.press('o')
  const overview = page.getByRole('region', { name: 'Overview', exact: true })
  await expect(overview).toBeVisible()
  const row = overview.locator('.attention-inbox .tray-row').first()
  await expect(row).toBeFocused()
  const frame = await row.evaluate((el) => {
    const li = getComputedStyle(el.closest('li')!)
    return { row: getComputedStyle(el).outlineStyle, li: li.outlineStyle, offset: li.outlineOffset }
  })
  expect(frame).toEqual({ row: 'none', li: 'solid', offset: '-2px' })

  await page.keyboard.press('Escape')
  await expect(overview).toHaveCount(0)
  await expect(page.locator('.request-title', { hasText: 'Run command' })).toBeVisible()
})
