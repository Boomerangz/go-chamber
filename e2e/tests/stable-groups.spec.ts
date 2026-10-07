import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { token } from '../playwright.config'
import { openNewSession, showPane } from './pane'

// An always-open page keeps its folder groups, and the recent-folder chips,
// where the owner saw them: activity elsewhere doesn't shuffle them; a
// reload orders them afresh.

const headers = { Authorization: `Bearer ${token}` }

async function sessionIn(page: Page, cwd: string, text: string): Promise<string> {
  const made = (await (await page.request.post('/api/sessions', { headers, data: { agent: 'claude', cwd } })).json()) as { id: string }
  await say(page, made.id, text)
  return made.id
}

async function say(page: Page, id: string, text: string) {
  await page.request.post(`/api/sessions/${id}/messages`, { headers, data: { text } })
  await expect
    .poll(async () => ((await (await page.request.get(`/api/sessions/${id}`, { headers })).json()) as { status: string }).status)
    .toBe('idle')
}

test('folder groups and recent chips keep their place until a reload', async ({ page }, info) => {
  const dir = (name: string) => {
    const d = path.join(realpathSync(mkdtempSync(path.join(tmpdir(), 'gc-stable-'))), `${name}-${info.project.name}`)
    mkdirSync(d)
    return d
  }
  const older = dir('older')
  const newer = dir('newer')
  const first = await sessionIn(page, older, 'older work')
  await sessionIn(page, newer, 'newer work')
  const olderName = path.basename(older)
  const newerName = path.basename(newer)

  await page.goto(`/?token=${token}`)
  await showPane(page, 'Sessions')
  const groups = () => page.locator('section.group').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
  const at = async (name: string) => (await groups()).indexOf(`Project ${name}`)
  await expect.poll(async () => (await at(newerName)) >= 0 && (await at(newerName)) < (await at(olderName))).toBe(true)
  await openNewSession(page)
  const chips = () => page.getByRole('group', { name: 'Recent folders' }).locator('button.chip').evaluateAll((els) => els.map((e) => e.getAttribute('title')))
  // Only four chips show: other tests' folders may crowd these out.
  const chipsBefore = await chips()

  // The older folder gets busy: nothing moves.
  await say(page, first, 'more work')
  // Let the activity reach the page.
  await page.waitForTimeout(500)
  expect(await at(newerName)).toBeLessThan(await at(olderName))
  if (chipsBefore.includes(newer) && chipsBefore.includes(older)) {
    expect((await chips()).indexOf(newer)).toBeLessThan((await chips()).indexOf(older))
  }

  // A new folder comes in on top of them.
  const third = dir('third')
  await sessionIn(page, third, 'third work')
  await expect.poll(async () => (await at(path.basename(third))) >= 0 && (await at(path.basename(third))) < (await at(newerName))).toBe(true)
  expect(await at(newerName)).toBeLessThan(await at(olderName))

  // A reload orders by activity again.
  await page.reload()
  await showPane(page, 'Sessions')
  await expect.poll(async () => (await at(olderName)) >= 0 && (await at(olderName)) < (await at(newerName))).toBe(true)
})
