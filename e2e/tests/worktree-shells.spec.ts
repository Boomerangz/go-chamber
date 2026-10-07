import { expect, test, type APIRequestContext } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { token } from '../playwright.config'
import { openNewSession, showPane } from './pane'

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

test('a branch a removed worktree kept is continued on from the new-session form', async ({ page }, info) => {
  const repo = newRepo()
  const name = `kept-${info.project.name}`
  const made = (await (await page.request.post('/api/worktrees', { headers, data: { agent: 'claude', cwd: repo, branch: name } })).json()) as Made
  const wt = made.worktree!
  writeFileSync(path.join(wt.path, 'work.txt'), 'done\n')
  execFileSync('git', ['add', '.'], { cwd: wt.path, env })
  execFileSync('git', ['commit', '-q', '-m', 'work'], { cwd: wt.path, env })
  expect((await page.request.delete(`/api/sessions/${made.id}/worktree`, { headers })).status()).toBe(200)
  // Another worktree holds a branch of its own.
  const busy = (await (await page.request.post('/api/worktrees', { headers, data: { agent: 'claude', cwd: repo, branch: `busy-${info.project.name}` } })).json()) as Made

  await page.goto(`/?token=${token}`)
  await showPane(page, 'Sessions')
  await openNewSession(page)
  await page.getByLabel('Working directory').fill(repo)
  await page.getByLabel('In a new worktree').check()
  const field = page.getByLabel('Branch name')
  const hint = page.locator('#new-session-branch-hint')
  const go = page.getByRole('button', { name: 'Continue on the existing branch' })

  // Checked out elsewhere: the form says where, and offers nothing to continue.
  await field.fill(`busy-${info.project.name}`)
  await page.getByRole('button', { name: 'New session' }).click()
  await expect(hint).toHaveText(`Branch ${busy.worktree!.branch} is checked out in ${busy.worktree!.path}`)
  await expect(go).toHaveCount(0)

  // Kept by a removed worktree: it can be gone on with.
  await field.fill(name)
  await page.getByRole('button', { name: 'New session' }).click()
  await expect(hint).toHaveText(`Branch ${wt.branch} already exists`)
  await expect(go).toBeVisible()
  await go.click()
  await expect(page.getByLabel('Message')).toBeVisible()
  const id = new URL(page.url()).pathname.split('/').pop()!
  const session = (await (await page.request.get(`/api/sessions/${id}`, { headers })).json()) as Made
  expect(session.id).not.toBe(made.id)
  expect(session.worktree).toMatchObject({ path: wt.path, branch: wt.branch })
  expect(existsSync(path.join(wt.path, 'work.txt'))).toBe(true)
  // The branch's own commit is what it holds to merge.
  await expect
    .poll(async () => ((await (await page.request.get(`/api/sessions/${id}/changes`, { headers })).json()) as { commits: number }).commits)
    .toBe(1)
})
