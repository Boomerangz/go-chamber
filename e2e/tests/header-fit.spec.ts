import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { token } from '../playwright.config'
import { openNewSession } from './pane'

async function newSession(page: Page, agent: 'Claude' | 'Codex') {
  await page.goto(`/?token=${token}`)
  await openNewSession(page)
  await page.getByRole('radio', { name: agent }).click()
  await page.getByLabel('Working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByLabel('Message')).toBeVisible()
}

// settle waits for the header to stop changing after a resize or a dock:
// its width (a dock may slide in) and its fold decision.
async function settle(page: Page) {
  const read = () => page.locator('.chat-header').evaluate((el) => `${el.clientWidth} ${el.dataset.fold ?? ''}`)
  let last = ''
  for (let i = 0; i < 30; i++) {
    const now = await read()
    if (now === last) return
    last = now
    await page.waitForTimeout(100)
  }
}

// oneRow says the header's title row is one row: every shown part of it
// (not the opened settings) sits beside the title, nothing spills sideways.
async function expectOneRow(page: Page, what: string) {
  const header = page.locator('.chat-header')
  // A resize settles once the header measured itself again.
  await expect.poll(() => header.evaluate((el) => {
    const heading = el.querySelector('.chat-heading')!.getBoundingClientRect()
    const parts = [...el.querySelectorAll<HTMLElement>(':scope > .avatar, :scope > .chat-more, .chat-meta > .status, .chat-meta > .usage, .chat-meta > .no-approvals, .chat-meta > .archived-tag')]
    const out = parts
      .filter((p) => p.getBoundingClientRect().width > 0)
      .filter((p) => { const r = p.getBoundingClientRect(); return r.top >= heading.bottom || r.bottom <= heading.top || r.right > el.getBoundingClientRect().right + 1 })
      .map((p) => p.className)
    if (el.scrollWidth > el.clientWidth + 1) out.push('header overflows')
    return out
  }), { message: what }).toEqual([])
}

const LONG = 'Refactor the session header so it never wraps into a second row with docks'

// With any dock beside the chat, at any desktop width, for either agent and
// a long title, the header stays one row, folded or not, details open or not.
for (const agent of ['Claude', 'Codex'] as const) {
  test(`${agent}'s header stays one row with every dock`, async ({ page, isMobile }) => {
    test.skip(isMobile, 'a phone folds by its own rules')
    test.setTimeout(90_000)
    await page.setViewportSize({ width: 1440, height: 900 })
    await newSession(page, agent)
    await page.getByLabel('Message').fill(LONG)
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(page.locator('.item.assistant', { hasText: `echo: ${LONG}` })).toBeVisible()
    const dock = page.getByRole('toolbar', { name: 'Dock' })
    for (const width of [900, 1280, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      for (const name of ['none', 'Terminal', 'Changes', 'Requests']) {
        const button = name === 'none' ? null : dock.getByRole('button', { name: new RegExp(`^${name}`) })
        if (button) await button.click()
        const what = `${agent} ${width} ${name}`
        await settle(page)
        await expectOneRow(page, what)
        const more = page.getByRole('button', { name: 'Session details' })
        if (await more.isVisible()) {
          await more.click()
          await settle(page)
          await expectOneRow(page, `${what}, details open`)
          if (await more.isVisible()) await more.click()
        }
        if (button && (await button.getAttribute('aria-pressed')) === 'true') await button.click()
      }
    }
  })
}

// At 1440 with no dock a long title is cut rather than fold Codex's settings.
test('a long Codex title leaves its settings inline at 1440px', async ({ page, isMobile }) => {
  test.skip(isMobile, 'a phone folds by its own rules')
  await page.setViewportSize({ width: 1440, height: 900 })
  await newSession(page, 'Codex')
  await page.getByLabel('Message').fill(LONG)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.item.assistant', { hasText: `echo: ${LONG}` })).toBeVisible()
  await expect(page.locator('.chat-header h2')).toContainText('Refactor')
  await expect(page.locator('.chat-header')).not.toHaveAttribute('data-fold')
  await expect(page.getByLabel('Approval reviewer')).toBeVisible()
  await expectOneRow(page, 'codex 1440 long title')
})

// At 1440 with no dock open both agents show their settings inline: Codex's
// mode and approvals are no longer folded behind "⋯" while Claude's show.
for (const agent of ['Claude', 'Codex'] as const) {
  test(`${agent} shows its settings inline at 1440px`, async ({ page, isMobile }) => {
    test.skip(isMobile, 'a phone folds by its own rules')
    await page.setViewportSize({ width: 1440, height: 900 })
    await newSession(page, agent)
    await page.getByLabel('Message').fill('hello header')
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(page.locator('.item.assistant', { hasText: 'echo: hello header' })).toBeVisible()
    const header = page.locator('.chat-header')
    await expect(header).not.toHaveAttribute('data-fold')
    await expect(page.getByRole('button', { name: 'Session details' })).toBeHidden()
    await expect(page.getByLabel('Permission mode')).toBeVisible()
    if (agent === 'Codex') await expect(page.getByLabel('Approval reviewer')).toBeVisible()
    expect(await header.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  })
}

// titleFirst lists where the usage line kept room the title or a worktree's
// branch needed, or shows only a stub of itself.
function titleFirst(page: Page) {
  return page.locator('.chat-header').evaluate((el) => {
    const out: string[] = []
    const cut = (e: Element | null) => !!e && e.scrollWidth > e.clientWidth + 1
    const usage = el.querySelector<HTMLElement>('.usage')
    const shown = !!usage && usage.getBoundingClientRect().width >= 1
    const title = el.querySelector('.chat-heading h2')
    const branch = el.querySelector('.chat-path-line .session-branch')
    const wide = Math.round(usage?.getBoundingClientRect().width ?? 0)
    if (shown && cut(title)) out.push(`title cut beside usage ${wide}px`)
    if (shown && cut(branch)) out.push(`branch cut beside usage ${wide}px`)
    if (shown && cut(usage) && wide < 72) out.push(`usage stub ${wide}px`)
    // hidden, the usage line had no room: the title and its pencil fill the heading
    const pencil = el.querySelector('.chat-heading .rename-btn')?.getBoundingClientRect().width ?? 0
    const spare = el.querySelector('.chat-heading')!.getBoundingClientRect().width - (title?.scrollWidth ?? 0) - pencil
    if (usage && !shown && !branch && spare > 90) out.push(`usage hidden beside ${Math.round(spare)}px to spare`)
    return out
  })
}

function newRepo(): string {
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
  const repo = path.join(realpathSync(mkdtempSync(path.join(tmpdir(), 'gc-fold-'))), 'repository-with-a-name')
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env })
  writeFileSync(path.join(repo, 'README.md'), 'hello\n')
  execFileSync('git', ['add', '.'], { cwd: repo, env })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo, env })
  return repo
}

// The title (and a worktree's branch under it) is cut only once the usage
// line has given way; the usage line is cut, then hidden, never kept as a
// stub of a few characters.
test('the title outranks the usage line, docked or not', async ({ page, isMobile }, info) => {
  test.skip(isMobile, 'a phone puts the usage line under the title')
  test.setTimeout(90_000)
  const repo = newRepo()
  const open = async (title: string, branch: string) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    const res = await page.request.post('/api/worktrees', {
      headers: { Authorization: `Bearer ${token}` },
      data: { agent: 'claude', cwd: repo, branch: `${branch}-${info.project.name}` },
    })
    const { id } = (await res.json()) as { id: string }
    await page.goto(`/s/${id}?token=${token}`)
    await page.getByLabel('Message').fill(title)
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(page.locator('.item.assistant', { hasText: `echo: ${title}` })).toBeVisible()
  }
  const dock = page.getByRole('toolbar', { name: 'Dock' })
  const check = async (cases: readonly (readonly [number, string])[], what: string) => {
    for (const [width, name] of cases) {
      await page.setViewportSize({ width, height: 900 })
      const button = name === 'none' ? null : dock.getByRole('button', { name: new RegExp(`^${name}`) })
      if (button && (await button.getAttribute('aria-pressed')) !== 'true') await button.click()
      await settle(page)
      await expect.poll(() => titleFirst(page), { message: `${what} ${width} ${name}` }).toEqual([])
      await expectOneRow(page, `${what} ${width} ${name}`)
      if (button) await button.click()
    }
  }
  await open('please keep the title', 'feature-fold')
  await check([[1280, 'none'], [1280, 'Changes'], [1024, 'Changes'], [1024, 'Terminal'], [900, 'none'], [768, 'none']], 'short')
  // A long title takes the row before the usage line gets any of it.
  await open(LONG, 'feature-long')
  await check([[1440, 'none'], [1280, 'none'], [1280, 'Changes'], [1024, 'Changes']], 'long')
})

// A short title leaves the usage line its room, for either agent.
for (const agent of ['Claude', 'Codex'] as const) {
  test(`${agent}'s usage line shows beside a short title`, async ({ page, isMobile }) => {
    test.skip(isMobile, 'a phone puts the usage line under the title')
    await page.setViewportSize({ width: 1280, height: 720 })
    await newSession(page, agent)
    await page.getByLabel('Message').fill('hello')
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(page.locator('.item.assistant', { hasText: 'echo: hello' })).toBeVisible()
    await settle(page)
    await expect(page.locator('.chat-header .usage')).toBeVisible()
    await expect.poll(() => titleFirst(page)).toEqual([])
  })
}
