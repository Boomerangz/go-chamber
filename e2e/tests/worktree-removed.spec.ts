import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { token } from '../playwright.config'
import { openNewSession, showPane, showSessionDetails } from './pane'

// What is left of a worktree session once its folder goes, and the ways to
// make it go: the Changes pane, the row's menu, or along with the session.

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const headers = { Authorization: `Bearer ${token}` }

function newRepo(): string {
  const repo = path.join(realpathSync(mkdtempSync(path.join(tmpdir(), 'gc-e2e-'))), 'app')
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env })
  writeFileSync(path.join(repo, 'README.md'), 'hello\n')
  execFileSync('git', ['add', '.'], { cwd: repo, env })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo, env })
  return repo
}

interface Made {
  id: string
  worktree: { path: string; branch: string }
}

// worktreeSession starts a worktree session that has had one turn, so it
// is named after its message and can be forked.
async function worktreeSession(request: APIRequestContext, repo: string, branch: string, title: string): Promise<Made> {
  const res = await request.post('/api/worktrees', { headers, data: { agent: 'claude', cwd: repo, branch } })
  const made = (await res.json()) as Made
  await request.post(`/api/sessions/${made.id}/messages`, { headers, data: { text: title } })
  await expect
    .poll(async () => ((await (await request.get(`/api/sessions/${made.id}`, { headers })).json()) as { status: string }).status)
    .toBe('idle')
  return made
}

async function openChanges(page: Page) {
  const bar = page.getByRole('navigation', { name: 'Views' })
  if (await bar.isVisible()) await bar.getByRole('button', { name: /^Changes/ }).click()
  else await page.getByRole('toolbar', { name: 'Dock' }).getByRole('button', { name: 'Changes' }).click()
  return page.getByRole('region', { name: 'Changes' })
}

test('a session whose worktree is removed stays in its repository, read-only, and forks into it', async ({ page }, info) => {
  const repo = newRepo()
  const title = `gone worktree ${info.project.name}`
  const { id, worktree } = await worktreeSession(page.request, repo, `gone-${info.project.name}`, title)
  const removed = await page.request.delete(`/api/sessions/${id}/worktree?force=1`, { headers })
  expect(removed.status()).toBe(200)
  expect(existsSync(worktree.path)).toBe(false)
  // The server refuses a turn where there is no folder.
  expect((await page.request.post(`/api/sessions/${id}/messages`, { headers, data: { text: 'more' } })).status()).toBe(409)

  await page.goto(`/s/${id}?token=${token}`)
  // The composer gives way to what is left and where to go on.
  const gone = page.getByRole('group', { name: 'Worktree removed' })
  await expect(gone).toContainText(`branch ${worktree.branch} kept in app`)
  await expect(page.getByLabel('Message')).toHaveCount(0)
  // Its actions fit, a phone's width included.
  expect(await gone.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  // The header still reads as the repository and its branch.
  const more = page.getByRole('button', { name: 'Session details' })
  if (await more.isVisible()) await more.click()
  await expect(page.locator('.chat-header .session-branch[data-removed]')).toHaveText(worktree.branch.replace('chamber/', ''))
  await expect(page.locator('.chat-header .chat-repo')).toHaveAttribute('title', repo)

  // Changes: no raw git error, the branch kept and how to merge it.
  const panel = await openChanges(page)
  await expect(panel.getByRole('status', { name: 'Worktree removed' })).toContainText(`branch ${worktree.branch} kept`)
  await expect(panel.getByText(/no such file|rev-parse|not a git repository/)).toHaveCount(0)

  // The list keeps it in the repository's group, marked; the gone folder is
  // offered nowhere.
  await showPane(page, 'Sessions')
  const row = page.locator('button.session', { hasText: title })
  await expect(row.locator('.session-branch[data-removed]')).toBeVisible()
  await expect(page.locator('.group', { has: row }).locator('.group-toggle')).toHaveAttribute('title', repo)
  await openNewSession(page)
  await expect(page.getByLabel('Working directory')).toHaveValue(repo)
  await expect(page.getByRole('group', { name: 'Recent folders' }).locator(`button[title="${worktree.path}"]`)).toHaveCount(0)

  // The conversation goes on in a fork in the repository.
  await showPane(page, 'Chat')
  await page.getByRole('button', { name: 'Fork into app' }).click()
  await expect(page.getByLabel('Message')).toBeVisible()
  await expect(page).not.toHaveURL(new RegExp(id))
  const forkId = new URL(page.url()).pathname.split('/').pop()!
  const fork = (await (await page.request.get(`/api/sessions/${forkId}`, { headers })).json()) as { cwd: string; worktree?: unknown }
  expect(fork.cwd).toBe(repo)
  expect(fork.worktree).toBeUndefined()
})

test('a worktree session’s menu removes its folder, or takes it along with the session', async ({ page }, info) => {
  const repo = newRepo()
  const first = await worktreeSession(page.request, repo, `menu-a-${info.project.name}`, `menu remove ${info.project.name}`)
  const second = await worktreeSession(page.request, repo, `menu-b-${info.project.name}`, `menu delete ${info.project.name}`)
  await page.goto(`/?token=${token}`)
  await showPane(page, 'Sessions')

  await page.getByRole('button', { name: `Actions for menu remove ${info.project.name}` }).click()
  await page.getByRole('menuitem', { name: 'Remove worktree…' }).click()
  const ask = page.getByRole('group', { name: `Remove the worktree of menu remove ${info.project.name}?` })
  await expect(ask).toContainText(`Branch ${first.worktree.branch} is kept`)
  await ask.getByRole('button', { name: 'Remove' }).click()
  await expect(page.locator('button.session', { hasText: `menu remove ${info.project.name}` }).locator('.session-branch[data-removed]')).toBeVisible()
  expect(existsSync(first.worktree.path)).toBe(false)

  await page.getByRole('button', { name: `Actions for menu delete ${info.project.name}` }).click()
  await page.getByRole('menuitem', { name: 'Delete…' }).click()
  const box = page.getByRole('checkbox', { name: /Also remove the worktree folder/ })
  await expect(box).not.toBeChecked()
  await box.check()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.locator('button.session', { hasText: `menu delete ${info.project.name}` })).toHaveCount(0)
  expect(existsSync(second.worktree.path)).toBe(false)
  expect(execFileSync('git', ['branch', '--list', second.worktree.branch], { cwd: repo, encoding: 'utf8' })).toContain(second.worktree.branch)
})

test('the branch field previews its branch, refuses in place, and unticks once started', async ({ page }, info) => {
  const repo = newRepo()
  const taken = `taken-${info.project.name}`
  await page.request.post('/api/worktrees', { headers, data: { agent: 'claude', cwd: repo, branch: taken } })
  await page.goto(`/?token=${token}`)
  await showPane(page, 'Sessions')
  await openNewSession(page)
  await page.getByLabel('Working directory').fill(repo)
  const box = page.getByRole('checkbox', { name: /In a new worktree/ })
  await box.check()
  const branch = page.getByLabel('Branch name')
  await branch.fill('fix/ws')
  await expect(branch).toHaveAccessibleDescription('→ chamber/fix-ws')
  await branch.fill('Фича тест')
  await expect(branch).toHaveAccessibleDescription('Use latin letters or digits')

  await branch.fill(taken)
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByRole('alert').filter({ hasText: `Branch chamber/${taken} already exists` })).toBeVisible()
  await expect(branch).toHaveAttribute('aria-invalid', 'true')
  // Said in the form, not in a corner notice.
  await expect(page.locator('.toast', { hasText: 'already exists' })).toHaveCount(0)

  await branch.fill(`fresh-${info.project.name}`)
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByLabel('Message')).toBeVisible()
  await showPane(page, 'Sessions')
  await openNewSession(page)
  await expect(page.getByRole('checkbox', { name: /In a new worktree/ })).not.toBeChecked()
})
