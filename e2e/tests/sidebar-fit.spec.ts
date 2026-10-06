import { expect, test, type Locator } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { token } from '../playwright.config'
import { openNewSession, showPane } from './pane'

// The sessions list keeps each row's facts on their own lines: what waits for
// the owner reads in full, and what is only context (a branch) yields.

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }

function newRepo(): string {
  const repo = path.join(realpathSync(mkdtempSync(path.join(tmpdir(), 'gc-fit-'))), 'app')
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env })
  writeFileSync(path.join(repo, 'README.md'), 'hello\n')
  execFileSync('git', ['add', '.'], { cwd: repo, env })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo, env })
  return repo
}

async function box(l: Locator) {
  const b = await l.boundingBox()
  if (!b) throw new Error('not rendered')
  return b
}

test('a quota window that reset says when, and the footer still fits', async ({ page }) => {
  const past = new Date(Date.now() - 16 * 86_400_000).toISOString()
  await page.route('**/api/quotas', (route) =>
    route.fulfill({
      json: [
        { agent: 'claude', windows: [{ name: 'five_hour', usedPct: 30, resetsAt: past }, { name: 'seven_day', usedPct: 12, resetsAt: past }] },
        { agent: 'codex', windows: [{ name: 'primary', usedPct: 64, status: '300m', resetsAt: past }] },
      ],
    }),
  )
  await page.goto(`/?token=${token}`)
  await showPane(page, 'Sessions')
  const summary = page.locator('.quotas-details summary')
  await expect(summary).toContainText('reset 16d ago')
  await expect(summary.locator('.quota-when').filter({ hasText: /reset$/ })).toHaveCount(0)
  const s = await box(summary)
  for (const mini of await summary.locator('.quota-mini').all()) {
    const m = await box(mini)
    expect(m.x + m.width).toBeLessThanOrEqual(s.x + s.width + 0.5)
  }
})

test('a waiting worktree row keeps "waiting for you" on one line; the branch yields', async ({ page }, info) => {
  const repo = newRepo()
  await page.goto(`/?token=${token}`)
  await showPane(page, 'Sessions')
  await openNewSession(page)
  await page.getByLabel('Working directory').fill(repo)
  await page.getByLabel('In a new worktree').check()
  await page.getByLabel('Branch name').fill(`add-the-quarterly-billing-export-${info.project.name}`)
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await page.getByLabel('Message').fill('ask me something')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('legend', { hasText: 'Which option should we use?' })).toBeVisible()

  await showPane(page, 'Sessions')
  const row = page.locator('.session.active')
  const status = row.locator('.session-status-waiting')
  await expect(status).toHaveText('waiting for you')
  const [s, t, r] = await Promise.all([box(status), box(row.locator('.session-time')), box(row)])
  // one line: as tall as the time beside it
  expect(s.height).toBeLessThanOrEqual(t.height + 1)
  // the branch is the one cut, and the row's facts stay inside the row
  const branch = row.locator('.session-branch')
  expect(await branch.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true)
  expect(t.x + t.width).toBeLessThanOrEqual(r.x + r.width)
})
