import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { token } from '../playwright.config'
import { openNewSession, showPane } from './pane'

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const LONG = 'some_really_long_file_name_that_goes_on_and_on_here.go'

// A repository whose changes include a long name, a deleted file, a binary
// file and enough lines to scroll.
function repo(): string {
  const dir = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gc-layout-'))), 'app')
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { env })
  fs.writeFileSync(path.join(dir, 'main.go'), 'package main\n\nfunc main() {}\n')
  fs.writeFileSync(path.join(dir, 'gone.txt'), 'bye\n')
  fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 3]))
  execFileSync('git', ['add', '.'], { cwd: dir, env })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir, env })
  const body = Array.from({ length: 120 }, (_, i) => `\tprintln("line ${i}")`).join('\n')
  fs.writeFileSync(path.join(dir, 'main.go'), `package main\n\nfunc main() {\n${body}\n}\n`)
  fs.rmSync(path.join(dir, 'gone.txt'))
  fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0, 9, 9, 9]))
  fs.mkdirSync(path.join(dir, 'web/src/components/deep'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'web/src/components/deep', LONG), 'package x\n')
  return dir
}

async function openChanges(page: Page, dir: string) {
  await page.goto(`/?token=${token}`)
  await showPane(page, 'Sessions')
  await openNewSession(page)
  await page.getByLabel('Working directory').fill(dir)
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByLabel('Message')).toBeVisible()
  const bar = page.getByRole('navigation', { name: 'Views' })
  if (await bar.isVisible()) await bar.getByRole('button', { name: /^Changes/ }).click()
  else await page.getByRole('toolbar', { name: 'Dock' }).getByRole('button', { name: 'Changes' }).click()
  return page.getByRole('region', { name: 'Changes' })
}

test('a long file name gives way before the counts, which line up', async ({ page }) => {
  const panel = await openChanges(page, repo())
  const rows = panel.locator('.diff-file-head')
  await expect(rows).toHaveCount(4)
  const rights: number[] = []
  for (const row of await rows.all()) {
    const path = (await row.locator('.diff-path').boundingBox())!
    const counts = (await row.locator('.diff-counts').boundingBox())!
    expect(path.x + path.width).toBeLessThanOrEqual(counts.x + 0.5)
    rights.push(Math.round(counts.x + counts.width))
  }
  expect(new Set(rights).size).toBe(1)
  const long = panel.getByRole('button', { name: new RegExp(LONG) })
  await expect(long).toHaveAttribute('title', `web/src/components/deep/${LONG}`)
  if (test.info().project.name === 'mobile') {
    const copy = (await rows.first().getByRole('button', { name: 'Copy path' }).boundingBox())!
    expect(copy.width).toBeGreaterThanOrEqual(36)
  }
})

test('a rename is one row from the old path, and an open file is framed as wide as its diff', async ({ page }) => {
  const dir = repo()
  fs.mkdirSync(path.join(dir, 'cmd'))
  // a rename with a small edit: git still finds it
  execFileSync('git', ['checkout', '--', 'main.go'], { cwd: dir, env })
  execFileSync('git', ['mv', 'main.go', 'cmd/entry.go'], { cwd: dir, env })
  fs.appendFileSync(path.join(dir, 'cmd/entry.go'), '\nfunc helper() {}\n')
  const panel = await openChanges(page, dir)
  const row = panel.getByRole('button', { name: /main\.go ?→ ?cmd\/ ?entry\.go/ })
  await expect(row).toBeVisible()
  await expect(panel.locator('.diff-file-head')).toHaveCount(4)
  // the name is whole, extension included
  const base = row.locator('.diff-base')
  expect(await base.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  await row.click()
  const file = panel.locator('.diff-file', { hasText: 'entry.go' })
  const view = file.locator('.diff-view')
  await expect(view).toBeVisible()
  // only the edits show, not the whole file as new
  await expect(view).toContainText('helper')
  await expect(view.locator('.diff-add', { hasText: 'package main' })).toHaveCount(0)
  const head = (await file.locator('.diff-file-head').boundingBox())!
  const body = (await view.boundingBox())!
  expect(Math.abs(head.width - body.width)).toBeLessThan(1)
})

test('similar long renames stay apart: each name keeps its end and extension', async ({ page }) => {
  const dir = repo()
  const names = ['header', 'footer', 'sidebar', 'toolbar'].map((n) => `renamed_component_with_a_long_name_${n}.tsx`)
  fs.mkdirSync(path.join(dir, 'src/components'), { recursive: true })
  for (const n of names) fs.writeFileSync(path.join(dir, 'src/components', n), 'export const x = 1\n'.repeat(20))
  execFileSync('git', ['add', '.'], { cwd: dir, env })
  execFileSync('git', ['commit', '-q', '-m', 'components'], { cwd: dir, env })
  fs.mkdirSync(path.join(dir, 'src/widgets'))
  for (const n of names) execFileSync('git', ['mv', `src/components/${n}`, `src/widgets/${n.replace('.tsx', '_v2.tsx')}`], { cwd: dir, env })
  const panel = await openChanges(page, dir)
  const rows = panel.locator('.diff-file-head').filter({ hasText: 'renamed_component' })
  await expect(rows).toHaveCount(4)
  const shown = new Set<string>()
  for (const row of await rows.all()) {
    const tail = row.locator('.diff-base .midcut-tail')
    // the end of the new name is whole and inside the row's path
    expect(await tail.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    const [t, p] = [(await tail.boundingBox())!, (await row.locator('.diff-path').boundingBox())!]
    expect(t.x + t.width).toBeLessThanOrEqual(p.x + p.width + 0.5)
    expect(await tail.textContent()).toMatch(/_v2\.tsx$/)
    shown.add((await tail.textContent())!)
  }
  expect(shown.size).toBe(4)
})

test('the panel’s controls stay in view and git’s header lines are gone', async ({ page }) => {
  const panel = await openChanges(page, repo())
  await panel.getByRole('button', { name: 'Expand all' }).click()
  await expect(panel.locator('.diff-file .diff-view').first()).toBeVisible()
  await expect(panel.getByText('loading diff…')).toHaveCount(0)
  await expect(panel.getByText(/^diff --git/)).toHaveCount(0)
  await expect(panel.getByText(/^index [0-9a-f]/)).toHaveCount(0)
  await expect(panel.locator('.diff-file', { hasText: 'blob.bin' })).toContainText('binary file · View')
  await panel.evaluate((el) => (el.scrollTop = el.scrollHeight))
  const box = (await panel.boundingBox())!
  const head = (await panel.locator('.diff-head').boundingBox())!
  expect(head.y).toBeGreaterThanOrEqual(box.y - 0.5)
  expect(head.y).toBeLessThan(box.y + 4)
  await expect(panel.getByRole('button', { name: 'Refresh changes' })).toBeInViewport()
})

test('the file viewer numbers lines, fills a phone and gives the focus back', async ({ page }) => {
  const panel = await openChanges(page, repo())
  const row = panel.locator('.diff-file', { hasText: 'main.go' })
  await row.hover()
  const view = row.getByRole('button', { name: 'View file' })
  await view.click()
  const viewer = page.getByRole('dialog')
  await expect(viewer.locator('.fv-ln').first()).toHaveText('1')
  await expect(viewer.getByRole('button', { name: /wrap/i })).toHaveCount(1)
  await expect(viewer.getByRole('button', { name: /copy/i })).toHaveCount(1)
  if (test.info().project.name === 'mobile') {
    const vp = page.viewportSize()!
    const box = (await viewer.boundingBox())!
    expect(box.width).toBeGreaterThanOrEqual(vp.width - 1)
    expect(box.height).toBeGreaterThanOrEqual(vp.height - 1)
    const path = viewer.locator('.file-viewer-path')
    expect(await path.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  }
  await viewer.getByRole('button', { name: 'Close' }).click()
  await expect(viewer).toBeHidden()
  await expect(view).toBeFocused()
})
