import { expect, test, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { token } from '../playwright.config'

// Phones held sideways and touch tablets: the wide layout with a finger's
// targets, a short window and the notch at a side.

const headers = { Authorization: `Bearer ${token}` }

async function sessionIn(page: Page, prefix: string) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
  const created = await page.request.post('/api/sessions', { headers, data: { agent: 'claude', cwd: dir } })
  const { id } = (await created.json()) as { id: string }
  return { dir, id }
}

test.describe('a phone held sideways', () => {
  test.use({ hasTouch: true, isMobile: true })
  for (const [width, height] of [[844, 390], [932, 430]]) {
    test(`the sessions stay reachable at ${width}x${height}`, async ({ page }, info) => {
      test.skip(info.project.name === 'mobile', 'the viewport is set here')
      await page.setViewportSize({ width, height })
      const { dir, id } = await sessionIn(page, 'gc-land-')
      await page.goto(`/?token=${token}`)
      // the search and the list are not squeezed away by the form and the footer
      const search = page.locator('.sidebar .session-search')
      await expect(search).toBeVisible()
      expect((await search.boundingBox())!.height).toBeGreaterThanOrEqual(30)
      const row = page.getByRole('region', { name: `Project ${path.basename(dir)}` }).locator('.session').first()
      await row.scrollIntoViewIfNeeded()
      await expect(row).toBeInViewport({ ratio: 0.9 })
      // nothing (the footer) sits over the row: the tap reaches it
      await row.tap()
      await expect(page).toHaveURL(new RegExp(`/s/${id}`))
    })
  }

  // edges lists the watched parts that reach into the notch or the home
  // indicator's strip.
  function edges(page: Page, inset: { left: number; right: number; bottom: number }) {
    return page.evaluate((inset) => {
      const out: string[] = []
      const W = window.innerWidth
      const H = window.innerHeight
      const watch = ['.brand h1', '.topbar-end', '.sidebar .segmented', '.sidebar .folder-field', '.dock-rail', '.composer', '.term-sidebar .folder-field', '.term-main']
      for (const s of watch) {
        const e = document.querySelector(s)
        if (!e) continue
        const r = e.getBoundingClientRect()
        if (r.width === 0) continue
        if (r.left < inset.left - 0.5) out.push(`${s} left ${Math.round(r.left)}`)
        if (r.right > W - inset.right + 0.5) out.push(`${s} right ${Math.round(r.right)}`)
        if (r.bottom > H - inset.bottom + 0.5) out.push(`${s} bottom ${Math.round(r.bottom)}`)
      }
      return out
    }, inset)
  }

  test('nothing sits under the notch or the home indicator', async ({ page }, info) => {
    test.skip(info.project.name === 'mobile', 'the viewport is set here')
    await page.setViewportSize({ width: 844, height: 390 })
    const inset = { top: 0, left: 47, right: 47, bottom: 21 }
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: inset })
    const { id } = await sessionIn(page, 'gc-notch-')
    await page.goto(`/?token=${token}`)
    await page.goto(`/s/${id}`)
    await expect(page.getByLabel('Message')).toBeVisible()
    await expect.poll(() => edges(page, inset)).toEqual([])
    await page.getByRole('radiogroup', { name: /mode/i }).getByRole('radio', { name: /^Terminal/ }).tap()
    await expect(page.locator('.term-sidebar')).toBeVisible()
    await expect.poll(() => edges(page, inset)).toEqual([])
  })
})

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const LONG = 'SomeVeryLongFileName_1.tsx'
const LONG_REPO = 'a-really-long-project-folder-name-for-a-phone'

function longRepo() {
  const dir = path.join(realpathSync(mkdtempSync(path.join(tmpdir(), 'gc-wt-'))), LONG_REPO)
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { env: gitEnv })
  writeFileSync(path.join(dir, 'README.md'), 'hello\n')
  execFileSync('git', ['add', '.'], { cwd: dir, env: gitEnv })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir, env: gitEnv })
  return dir
}

test.describe('a phone', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })
  test('a worktree chip under Projects keeps its branch; the repository name gives way', async ({ page }, info) => {
    const branch = `phone-${info.project.name}-${Date.now() % 100000}`
    await page.request.post('/api/worktrees', { headers, data: { agent: 'claude', cwd: longRepo(), branch } })
    await page.goto(`/terminal?token=${token}`)
    const chip = page.getByRole('button', { name: `Open terminal in ${LONG_REPO} ⎇ ${branch}` })
    await expect(chip).toBeVisible()
    const fit = await chip.evaluate((el) => {
      const b = el.querySelector('.chip-branch')!
      const repo = el.querySelector('.chip-label')!
      const c = el.getBoundingClientRect()
      return { whole: b.scrollWidth <= b.clientWidth, inside: b.getBoundingClientRect().right <= c.right + 0.5, repoCut: repo.scrollWidth > repo.clientWidth, repoShown: repo.getBoundingClientRect().width }
    })
    expect(fit).toEqual({ whole: true, inside: true, repoCut: true, repoShown: expect.any(Number) })
    expect(fit.repoShown).toBeGreaterThanOrEqual(20)
  })
})

// changedRepo is a repository with a changed file deep in folders, under a
// long name, beside a short one.
function changedRepo() {
  const dir = path.join(realpathSync(mkdtempSync(path.join(tmpdir(), 'gc-tab-'))), 'app')
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { env: gitEnv })
  writeFileSync(path.join(dir, 'README.md'), 'hello\n')
  execFileSync('git', ['add', '.'], { cwd: dir, env: gitEnv })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir, env: gitEnv })
  mkdirSync(path.join(dir, 'src/components/deeply/nested'), { recursive: true })
  writeFileSync(path.join(dir, 'src/components/deeply/nested', LONG), 'x\n'.repeat(120))
  writeFileSync(path.join(dir, 'README.md'), 'hello\nagain\n')
  return dir
}

async function openDock(page: Page, name: string) {
  const button = page.getByRole('toolbar', { name: 'Dock' }).getByRole('button', { name: new RegExp(`^${name}`) })
  if ((await button.getAttribute('aria-pressed')) !== 'true') await button.tap()
  await expect(button).toHaveAttribute('aria-pressed', 'true')
}

async function side(l: Locator) {
  const b = (await l.boundingBox())!
  return Math.round(Math.min(b.width, b.height))
}

test.describe('a touch tablet', () => {
  test.use({ hasTouch: true })
  for (const [width, height] of [[768, 1024], [820, 1180], [1024, 768]]) {
    test(`the docks' controls are finger-sized and a long name keeps its end at ${width}`, async ({ page }, info) => {
      test.skip(info.project.name === 'mobile', 'the viewport is set here')
      await page.addInitScript(() => Object.defineProperty(window, 'RTCPeerConnection', { value: undefined }))
      await page.setViewportSize({ width, height })
      const created = await page.request.post('/api/sessions', { headers, data: { agent: 'claude', cwd: changedRepo() } })
      const { id } = (await created.json()) as { id: string }
      await page.goto(`/?token=${token}`)
      await page.goto(`/s/${id}`)
      await expect(page.getByLabel('Message')).toBeVisible()

      await openDock(page, 'Changes')
      const panel = page.getByRole('region', { name: 'Changes' })
      const row = panel.locator('.diff-file-head').filter({ hasText: 'nested' })
      await expect(row).toBeVisible()
      for (const name of ['Copy path', 'View file']) expect(await side(row.getByRole('button', { name })), name).toBeGreaterThanOrEqual(36)
      if (width <= 1100) expect(await side(page.locator('.topbar .show-sessions')), 'Show sessions').toBeGreaterThanOrEqual(36)
      // the name's end and extension show whole, inside the row, and some of its start besides
      const tail = row.locator('.diff-base .midcut-tail')
      await expect(tail).toHaveText(/_1\.tsx$/)
      expect(await tail.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
      const [t, clip] = [(await tail.boundingBox())!, (await row.locator('.diff-new').boundingBox())!]
      expect(t.x + t.width).toBeLessThanOrEqual(clip.x + clip.width + 0.5)
      expect((await row.locator('.diff-base').boundingBox())!.width).toBeGreaterThanOrEqual(t.width + 14)
      // the counts show, inside the row
      const [counts, head] = [(await row.locator('.diff-counts').boundingBox())!, (await row.boundingBox())!]
      expect(counts.width).toBeGreaterThan(10)
      expect(counts.x + counts.width).toBeLessThanOrEqual(head.x + head.width + 0.5)

      await openDock(page, 'Terminal')
      const terms = page.getByRole('region', { name: 'Terminals' })
      await terms.getByRole('button', { name: 'New terminal in session dir' }).tap()
      await expect(terms.getByRole('tab', { selected: true })).toBeVisible()
      expect(await side(terms.getByRole('button', { name: 'More terminals' })), 'More terminals').toBeGreaterThanOrEqual(36)
      await terms.getByRole('button', { name: /^Close terminal / }).first().tap()
      await terms.getByRole('group', { name: /^Close terminal / }).getByRole('button', { name: 'Close', exact: true }).tap()
    })
  }
})
