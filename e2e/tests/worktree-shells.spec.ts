import { expect, test, type APIRequestContext } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { token } from '../playwright.config'
import { showPane } from './pane'

// Shells and branches outlive a worktree folder no longer than they should:
// removing the folder closes the terminals in it, deleting a session lets
// go of its terminals, and a branch a removed worktree kept can be worked
// on again.

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
  cwd: string
  worktree?: { path: string; branch: string }
}

interface Shell {
  id: string
  title: string
  sessionId?: string
}

// named sends one turn so the session is named after its message.
async function named(request: APIRequestContext, made: Made, title: string): Promise<Made> {
  await request.post(`/api/sessions/${made.id}/messages`, { headers, data: { text: title } })
  await expect
    .poll(async () => ((await (await request.get(`/api/sessions/${made.id}`, { headers })).json()) as { status: string }).status)
    .toBe('idle')
  return made
}

async function shellFor(request: APIRequestContext, sessionId: string): Promise<Shell> {
  const res = await request.post('/api/terminals', { headers, data: { sessionId } })
  expect(res.status()).toBe(201)
  return (await res.json()) as Shell
}

async function shells(request: APIRequestContext): Promise<Shell[]> {
  return (await (await request.get('/api/terminals', { headers })).json()) as Shell[]
}

test('removing a worktree closes its terminals on every open page; deleting a session lets go of its terminal', async ({ page, browser, baseURL }, info) => {
  const repo = newRepo()
  const wtTitle = `shells in worktree ${info.project.name}`
  const plainTitle = `shells in folder ${info.project.name}`
  const res = await page.request.post('/api/worktrees', { headers, data: { agent: 'claude', cwd: repo, branch: `shells-${info.project.name}` } })
  const wt = await named(page.request, (await res.json()) as Made, wtTitle)
  const plain = await named(page.request, (await (await page.request.post('/api/sessions', { headers, data: { agent: 'claude', cwd: repo } })).json()) as Made, plainTitle)
  const inWorktree = await shellFor(page.request, wt.id)
  const inFolder = await shellFor(page.request, plain.id)

  // Another device watches the terminals.
  const device = await browser.newContext({ baseURL })
  const other = await device.newPage()
  await other.goto(`/?token=${token}`)
  await other.getByRole('radio', { name: /^Terminal/ }).click()
  const list = other.getByRole('region', { name: 'Terminals' }).getByRole('tablist')
  await expect(list.getByRole('tab', { name: new RegExp(`^${inWorktree.title} [/~]`) })).toBeVisible()

  await page.goto(`/?token=${token}`)
  await showPane(page, 'Sessions')
  await page.getByRole('button', { name: `Actions for ${wtTitle}` }).click()
  await page.getByRole('menuitem', { name: 'Remove worktree…' }).click()
  const ask = page.getByRole('group', { name: `Remove the worktree of ${wtTitle}?` })
  await expect(ask).toContainText('1 terminal in it will close.')
  await ask.getByRole('button', { name: 'Remove' }).click()
  await expect(page.locator('button.session', { hasText: wtTitle }).locator('.session-branch[data-removed]')).toBeVisible()

  // The shell is gone from the server and from the other page's list.
  expect((await shells(page.request)).some((t) => t.id === inWorktree.id)).toBe(false)
  await expect(list.getByRole('tab', { name: new RegExp(`^${inWorktree.title} [/~]`) })).toHaveCount(0)
  await expect(list.getByRole('tab', { name: new RegExp(`^${inFolder.title} [/~]`) })).toBeVisible()

  // Deleting a session keeps its shell running, as an ordinary terminal.
  await page.getByRole('button', { name: `Actions for ${plainTitle}` }).click()
  await page.getByRole('menuitem', { name: 'Delete…' }).click()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.locator('button.session', { hasText: plainTitle })).toHaveCount(0)
  const kept = (await shells(page.request)).find((t) => t.id === inFolder.id)
  expect(kept).toMatchObject({ status: 'running' })
  expect(kept?.sessionId).toBeUndefined()
  await device.close()
  await page.request.delete(`/api/terminals/${inFolder.id}`, { headers })
})
