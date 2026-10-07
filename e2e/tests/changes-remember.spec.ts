import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { token } from '../playwright.config'

const headers = { Authorization: `Bearer ${token}` }
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }

// A repository with three changed files, each long enough to scroll.
function repo(): string {
  const dir = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gc-remember-'))), 'app')
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { env })
  for (const f of ['a.go', 'b.go', 'c.go']) fs.writeFileSync(path.join(dir, f), 'package main\n')
  execFileSync('git', ['add', '.'], { cwd: dir, env })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir, env })
  for (const f of ['a.go', 'b.go', 'c.go']) {
    const body = Array.from({ length: 80 }, (_, i) => `// ${f} line ${i}`).join('\n')
    fs.writeFileSync(path.join(dir, f), `package main\n${body}\n`)
  }
  return dir
}

async function session(page: Page, cwd: string, title: string): Promise<string> {
  const r = await page.request.post('/api/sessions', { headers, data: { agent: 'claude', cwd } })
  const { id } = (await r.json()) as { id: string }
  await page.request.post(`/api/sessions/${id}/title`, { headers, data: { title } })
  return id
}

// open switches sessions inside the page: a reload would start afresh.
async function open(page: Page, title: string) {
  await page.getByRole('searchbox', { name: 'Search sessions' }).fill(title)
  await page.locator('button.session', { hasText: title }).first().click()
  await expect(page.getByRole('heading', { name: title })).toBeVisible()
}

const dock = (page: Page) => page.getByRole('toolbar', { name: 'Dock' })

// Changes keeps the files a session had open, and where it was scrolled,
// when the panel goes away and comes back: another dock tab, another session.
test('Changes keeps a session’s open files and scroll across the dock, Overview and another session', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the dock is desktop-only')
  await page.addInitScript(() => Object.defineProperty(window, 'RTCPeerConnection', { value: undefined }))
  const dir = repo()
  const stamp = Date.now().toString(36)
  const one = await session(page, dir, `remember one ${stamp}`)
  await session(page, dir, `remember two ${stamp}`)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/s/${one}?token=${token}`)
  await dock(page).getByRole('button', { name: 'Changes' }).click()
  const panel = page.getByRole('region', { name: 'Changes' })
  await panel.getByRole('button', { name: /^b\.go/ }).click()
  await panel.getByRole('button', { name: /^c\.go/ }).click()
  await expect(panel.getByText('// c.go line 79')).toBeAttached()
  await panel.evaluate((el) => (el.scrollTop = 600))
  // the place is saved on the next frame
  await page.waitForTimeout(100)
  const scrolled = await panel.evaluate((el) => el.scrollTop)
  expect(scrolled).toBeGreaterThan(400)

  const expanded = () =>
    panel.locator('.diff-file-toggle[aria-expanded="true"]').evaluateAll((els) => els.map((e) => e.getAttribute('title')))
  const back = async (how: string) => {
    await expect(panel.getByText('// c.go line 79'), how).toBeAttached()
    expect(await expanded(), how).toEqual(['b.go', 'c.go'])
    await expect.poll(() => panel.evaluate((el) => el.scrollTop), { message: how }).toBe(scrolled)
  }

  // over to Terminal and back
  await dock(page).getByRole('button', { name: /^Terminal/ }).click()
  await expect(panel).toHaveCount(0)
  await dock(page).getByRole('button', { name: 'Changes' }).click()
  await back('dock')

  // Overview and back
  const overview = page.getByRole('button', { name: 'Overview', exact: true })
  await overview.click()
  await expect(panel).toHaveCount(0)
  await overview.click()
  await back('overview')

  // another session has its own: nothing open, at the top; and back again
  await open(page, `remember two ${stamp}`)
  await expect(panel.getByRole('button', { name: /^a\.go/ })).toBeVisible()
  expect(await expanded()).toEqual([])
  expect(await panel.evaluate((el) => el.scrollTop)).toBe(0)
  await open(page, `remember one ${stamp}`)
  await back('session')
})

// An open file's header has given its actions room already: they show there
// without a hover, instead of a blank gap before the counts.
test('an open file shows its copy and view actions without a hover', async ({ page, isMobile }) => {
  test.skip(isMobile, 'a touch screen shows every row’s actions')
  const dir = repo()
  const id = await session(page, dir, `actions ${Date.now().toString(36)}`)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/s/${id}?token=${token}`)
  await dock(page).getByRole('button', { name: 'Changes' }).click()
  const panel = page.getByRole('region', { name: 'Changes' })
  await panel.getByRole('button', { name: /^a\.go/ }).click()
  await expect(panel.getByText('// a.go line 0')).toBeVisible()
  // the pointer rests elsewhere, and focus leaves the row
  await panel.getByRole('heading', { name: 'Changes' }).hover()
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  // past the actions' fade, were they to fade
  await page.waitForTimeout(400)
  const rows = panel.locator('.diff-file-head')
  await expect(rows.nth(0).locator('.diff-file-actions')).toHaveCSS('opacity', '1')
  // a closed row keeps them hidden until hovered
  await expect(rows.nth(1).locator('.diff-file-actions')).toHaveCSS('opacity', '0')
})
