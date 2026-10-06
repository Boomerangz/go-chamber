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
  await page.getByLabel('working directory').fill(repo)
  await page.getByLabel('In a new worktree').check()
  await page.getByLabel('branch name').fill(branch)
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByLabel('message')).toBeVisible()

  const sessions: { worktree?: { path: string; branch: string; repo: string } }[] = await (await page.request.get('/api/sessions')).json()
  const wt = sessions.find((s) => s.worktree?.repo === repo)!.worktree!
  expect(wt.branch).toBe(`chamber/${branch}`)

  const bar = page.getByRole('navigation', { name: 'Views' })
  if (await bar.isVisible()) await bar.getByRole('button', { name: /^Changes/ }).click()
  else await page.getByRole('toolbar', { name: 'Dock' }).getByRole('button', { name: 'Changes' }).click()
  const panel = page.getByRole('region', { name: 'Changes' })
  await expect(panel.getByText(`git -C ${repo} merge chamber/${branch}`)).toBeVisible()
  await expect(panel.getByText('No changes')).toBeVisible()

  writeFileSync(path.join(wt.path, 'agent.txt'), 'from the agent\n')
  await panel.getByRole('button', { name: 'Refresh changes' }).click()
  await panel.getByRole('button', { name: /agent\.txt/ }).click()
  await expect(panel.getByText('+from the agent')).toBeVisible()

  await panel.getByRole('button', { name: 'Remove worktree' }).click()
  await panel.getByRole('button', { name: 'Remove anyway' }).click()
  await expect(panel.getByRole('button', { name: /Remove/ })).toHaveCount(0)
  expect(execFileSync('git', ['branch', '--list', `chamber/${branch}`], { cwd: repo, encoding: 'utf8' })).toContain(branch)
})
