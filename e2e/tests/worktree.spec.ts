import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { token } from '../playwright.config'
import { openNewSession, showPane } from './pane'

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }

function newRepo(): string {
  const repo = path.join(realpathSync(mkdtempSync(path.join(tmpdir(), 'gc-e2e-'))), 'app')
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env })
  writeFileSync(path.join(repo, 'README.md'), 'hello\n')
  execFileSync('git', ['add', '.'], { cwd: repo, env })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo, env })
  return repo
}

test('works in a new worktree and shows its changes', async ({ page }, info) => {
  const repo = newRepo()
  const branch = `e2e-${info.project.name}`
  await page.goto(`/?token=${token}`)
  await showPane(page, 'Sessions')
  await openNewSession(page)
  await page.getByLabel('Working directory').fill(repo)
  await page.getByLabel('In a new worktree').check()
  await page.getByLabel('Branch name').fill(branch)
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByLabel('Message')).toBeVisible()

  const sessions: { worktree?: { path: string; branch: string; repo: string } }[] = await (await page.request.get('/api/sessions')).json()
  const wt = sessions.find((s) => s.worktree?.repo === repo)!.worktree!
  expect(wt.branch).toBe(`chamber/${branch}`)

  const bar = page.getByRole('navigation', { name: 'Views' })
  if (await bar.isVisible()) await bar.getByRole('button', { name: /^Changes/ }).click()
  else await page.getByRole('toolbar', { name: 'Dock' }).getByRole('button', { name: 'Changes' }).click()
  const panel = page.getByRole('region', { name: 'Changes' })
  // Nothing to merge until the branch has a commit.
  await expect(panel.getByText(/no commits yet/)).toBeVisible()
  await expect(panel.getByText(`git -C ${repo} merge chamber/${branch}`)).toHaveCount(0)
  await expect(panel.getByText('No changes')).toBeVisible()
  writeFileSync(path.join(wt.path, 'first.txt'), 'one\n')
  execFileSync('git', ['add', '.'], { cwd: wt.path, env })
  execFileSync('git', ['commit', '-q', '-m', 'first'], { cwd: wt.path, env })
  await panel.getByRole('button', { name: 'Refresh changes' }).click()
  await expect(panel.getByText(`git -C ${repo} merge chamber/${branch}`)).toBeVisible()
  await expect(panel.getByText(/1 commit to merge/)).toBeVisible()

  writeFileSync(path.join(wt.path, 'agent.txt'), 'from the agent\n')
  await panel.getByRole('button', { name: 'Refresh changes' }).click()
  await panel.getByRole('button', { name: /agent\.txt/ }).click()
  await expect(panel.getByText('+from the agent')).toBeVisible()

  await panel.getByRole('button', { name: 'Remove worktree' }).click()
  await panel.getByRole('button', { name: 'Remove anyway' }).click()
  await expect(panel.getByRole('button', { name: /Remove/ })).toHaveCount(0)
  expect(execFileSync('git', ['branch', '--list', `chamber/${branch}`], { cwd: repo, encoding: 'utf8' })).toContain(branch)
})

test('a worktree session sits in its repository’s group, by branch; recent folders keep the repository', async ({ page }, info) => {
  const repo = newRepo()
  const headers = { Authorization: `Bearer ${token}` }
  const branch = `group-${info.project.name}`
  const res = await page.request.post('/api/worktrees', { headers, data: { agent: 'claude', cwd: repo, branch } })
  const { id, worktree } = (await res.json()) as { id: string; worktree: { path: string } }
  await page.goto(`/s/${id}?token=${token}`)
  await showPane(page, 'Sessions')
  const row = page.locator('.groups button.session[aria-current="true"]')
  await expect(row.locator('.session-branch')).toHaveText(branch)
  await expect(page.locator('.group', { has: page.locator('button.session[aria-current="true"]') }).locator('.group-toggle')).toHaveAttribute('title', repo)
  // the only session of the project is archived: the project stays a recent folder, as the repository
  await page.request.post(`/api/sessions/${id}/archive`, { headers })
  await page.reload()
  await showPane(page, 'Sessions')
  await openNewSession(page)
  const chips = page.getByRole('group', { name: 'Recent folders' })
  await expect(chips.locator(`button[title="${repo}"]`)).toHaveCount(1)
  await expect(chips.locator(`button[title="${worktree.path}"]`)).toHaveCount(0)
})

test('a worktree asks for its branch by name, and only a repository offers one', async ({ page }) => {
  const repo = newRepo()
  const plain = realpathSync(mkdtempSync(path.join(tmpdir(), 'gc-plain-')))
  await page.goto(`/?token=${token}`)
  await showPane(page, 'Sessions')
  await openNewSession(page)
  const folder = page.getByLabel('Working directory')
  await folder.fill(plain)
  const box = page.getByRole('checkbox', { name: /In a new worktree/ })
  await expect(box).toBeDisabled()
  await expect(page.locator('.worktree-off')).toHaveText(/not a git repository/)
  await folder.fill(repo)
  await expect(box).toBeEnabled()
  await box.check()
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  const branch = page.getByLabel('Branch name')
  await expect(branch).toBeFocused()
  await expect(page.getByRole('alert').filter({ hasText: 'Name the branch' })).toBeVisible()
  await expect(branch).toHaveAccessibleDescription('Name the branch')
})
