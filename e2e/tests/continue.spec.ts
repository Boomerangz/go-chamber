import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { token } from '../playwright.config'
import { openNewSession, showSessionDetails } from './pane'

async function newSession(page: import('@playwright/test').Page, agent: 'Claude' | 'Codex' | 'OpenCode' = 'Claude', cwd = '/tmp') {
  await page.goto(`/?token=${token}`)
  const bar = page.getByRole('navigation', { name: 'Views' })
  if (await bar.isVisible()) await bar.getByRole('button', { name: /^Sessions/ }).click()
  await openNewSession(page)
  await page.getByRole('radio', { name: agent }).click()
  await page.getByLabel('Working directory').fill(cwd)
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByLabel('Message')).toBeVisible()
}

test('continues a turn cut off by a crash', async ({ page }, info) => {
  await newSession(page)
  await page.getByLabel('Message').fill(`crash now ${info.project.name}`)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('.banner', { hasText: 'Turn interrupted' })).toBeVisible()
  await expect(page.getByText(/exited unexpectedly/)).toBeVisible()

  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(page.getByText('echo: Continue from where you stopped.')).toBeVisible()
  await expect(page.locator('.chat-meta .status', { hasText: 'idle' })).toBeVisible()
  await expect(page.locator('.banner', { hasText: 'Turn interrupted' })).toHaveCount(0)
})

test('forks a session and keeps talking on the branch', async ({ page }, info) => {
  const text = `fork base ${info.project.name}`
  await newSession(page)
  await page.getByLabel('Message').fill(text)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByText(`echo: ${text}`)).toBeVisible()

  await showSessionDetails(page)
  await page.getByRole('button', { name: 'Fork', exact: true }).click()
  await page.getByRole('button', { name: 'Create fork', exact: true }).click()
  await expect(page.getByRole('heading', { name: `${text} (fork)` })).toBeVisible()
  await page.getByLabel('Message').fill('on the branch')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByText('echo: on the branch')).toBeVisible()

  const bar = page.getByRole('navigation', { name: 'Views' })
  if (await bar.isVisible()) await bar.getByRole('button', { name: /^Sessions/ }).click()
  await expect(page.locator('.session', { hasText: `${text} (fork)` }).locator('.session-fork')).toBeVisible()
})

test('keeps Claude answers after restarting its runtime', async ({ page }) => {
  await newSession(page)
  await page.getByLabel('Message').fill('before runtime restart')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByText('echo: before runtime restart')).toBeVisible()
  await expect(page.locator('.chat-meta .status', { hasText: 'idle' })).toBeVisible()

  await showSessionDetails(page)
  await page.getByLabel('Permission mode').selectOption('bypassPermissions')
  await page.getByRole('group', { name: /^Confirm/ }).getByRole('button', { name: 'Switch' }).click()
  await expect(page.locator('.chat-meta .no-approvals')).toBeVisible()
  await page.getByLabel('Message').fill('after runtime restart')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByText('echo: after runtime restart')).toBeVisible()
  await expect(page.getByText('echo: before runtime restart')).toBeVisible()
  await page.reload()
  await expect(page.getByText('echo: before runtime restart')).toBeVisible()
  await expect(page.getByText('echo: after runtime restart')).toBeVisible()
})

test('keeps user messages and answers in a Codex fork', async ({ page }, info) => {
  const text = `Codex fork base ${info.project.name}`
  await newSession(page, 'Codex')
  await page.getByLabel('Message').fill(text)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByText(`echo: ${text}`)).toBeVisible()
  await expect(page.locator('.chat-meta .status', { hasText: 'idle' })).toBeVisible()
  await showSessionDetails(page)
  await page.getByRole('button', { name: 'Fork', exact: true }).click()
  await page.getByRole('button', { name: 'Create fork', exact: true }).click()
  await expect(page.getByRole('heading', { name: `${text} (fork)` })).toBeVisible()
  await expect(page.locator('.item.user', { hasText: text })).toBeVisible()
  await expect(page.getByText(`echo: ${text}`)).toBeVisible()
  await page.reload()
  await expect(page.locator('.item.user', { hasText: text })).toBeVisible()
  await expect(page.getByText(`echo: ${text}`)).toBeVisible()
})

for (const [source, target] of [['Claude', 'codex'], ['Codex', 'claude'], ['Claude', 'opencode'], ['Codex', 'opencode'], ['OpenCode', 'claude'], ['OpenCode', 'codex']] as const) {
 test(`forks ${source} to ${target} with a transcript file`, async ({ page }, info) => {
  const text = `handoff ${source} to ${target} ${info.project.name}`
  await newSession(page, source)
  await page.getByLabel('Message').fill(text)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByText(`echo: ${text}`)).toBeVisible()
  await expect(page.locator('.chat-meta .status', { hasText: 'idle' })).toBeVisible()
  const parentURL = page.url()
  await showSessionDetails(page)
  await page.getByRole('button', { name: 'Fork', exact: true }).click()
  await page.getByLabel('Fork agent').selectOption(target)
  await page.getByRole('button', { name: 'Create fork', exact: true }).click()
  await expect(page.getByRole('heading', { name: `${text} (fork)` })).toBeVisible()
  expect(page.url()).not.toBe(parentURL)
  await expect(page.locator(`.chat-header .avatar-${target}`)).toBeAttached()
  const handoff = page.locator('.item.user', { hasText: 'Read its full transcript file at' })
  await expect(handoff).toBeVisible()
  const prompt = await handoff.innerText()
  const path = prompt.match(/transcript file at "([^"]+)"/)?.[1]
  expect(path).toBeTruthy()
  const transcript = await readFile(path!, 'utf8')
  expect(transcript).toContain(text)
  expect(transcript).toContain(`echo: ${text}`)
  // Claude/Codex fakes request approval for any prompt mentioning permission.
  if (target !== 'opencode') await page.locator('.chat .request').getByRole('button', { name: 'Allow', exact: true }).click()
  await expect(page.locator('.chat-meta .status', { hasText: 'idle' })).toBeVisible()
  await page.getByLabel('Message').fill('continue on new agent')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByText('echo: continue on new agent')).toBeVisible()
  await page.reload()
  await expect(page.getByText('echo: continue on new agent')).toBeVisible()
  expect(await readFile(path!, 'utf8')).toBe(transcript)
 })
}


test('keeps a failed bootstrap in its fork and retries without creating another session', async ({ page }) => {
 const cwd = mkdtempSync(path.join(tmpdir(), 'gc-fork-send-error-'))
 await newSession(page, 'Claude', cwd)
 await page.getByLabel('Message').fill('bootstrap recovery')
 await page.getByRole('button', { name: 'Send', exact: true }).click()
 await expect(page.getByText('echo: bootstrap recovery')).toBeVisible()
 const parentID = new URL(page.url()).pathname.split('/').pop()!
 await showSessionDetails(page)
 await page.getByRole('button', { name: 'Fork', exact: true }).click()
 await page.getByLabel('Fork agent').selectOption('codex')
 await page.getByRole('button', { name: 'Create fork', exact: true }).click()
 await expect(page.getByRole('heading', { name: 'bootstrap recovery (fork)' })).toBeVisible()
 const childURL = page.url()
 const failed = page.locator('.item-error', { hasText: 'injected bootstrap delivery failure' })
 await expect(failed).toBeVisible()
 await page.reload()
 await expect(failed).toBeVisible()
 await failed.getByRole('button', { name: 'Retry', exact: true }).click()
 await page.locator('.chat .request').getByRole('button', { name: 'Allow', exact: true }).click()
 await expect(page.locator('.chat-meta .status', { hasText: 'idle' })).toBeVisible()
 expect(page.url()).toBe(childURL)
 await expect(page.locator('.item.user', { hasText: 'Read its full transcript file at' })).toHaveCount(2)
 const sessions = await (await page.request.get('/api/sessions', { headers: { Authorization: `Bearer ${token}` } })).json()
 expect(sessions.filter((s: { forkOf?: string }) => s.forkOf === parentID)).toHaveLength(1)
})

test('includes a pending question and option descriptions in the handoff file', async ({ page }) => {
 await newSession(page, 'Codex')
 await page.getByLabel('Message').fill('ask about next steps')
 await page.getByRole('button', { name: 'Send', exact: true }).click()
 await expect(page.locator('legend', { hasText: 'Which option should we use?' })).toBeVisible()
 const parentURL = page.url()
 await showSessionDetails(page)
 await page.getByRole('button', { name: 'Fork', exact: true }).click()
 await page.getByLabel('Fork agent').selectOption('opencode')
 await page.getByRole('button', { name: 'Create fork', exact: true }).click()
 const handoff = page.locator('.item.user', { hasText: 'Read its full transcript file at' })
 await expect(handoff).toBeVisible()
 const file = (await handoff.innerText()).match(/transcript file at "([^"]+)"/)?.[1]
 expect(file).toBeTruthy()
 const text = await readFile(file!, 'utf8')
 expect(text).toContain('Which option should we use?')
 expect(text).toContain('"description":"first"')
 expect(text).toContain('"description":"second"')
 expect(text).toContain('pending at fork; not transferred')
 await page.goto(parentURL)
 await expect(page.locator('legend', { hasText: 'Which option should we use?' })).toBeVisible()
})
