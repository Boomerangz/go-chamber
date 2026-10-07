import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import { token } from '../playwright.config'
import { showPane } from './pane'

// The Overview's results are the turns the owner hasn't seen on any device,
// as the sidebar marks them: a reload keeps them, a look clears both.

const headers = { Authorization: `Bearer ${token}` }
const ownDir = () => fs.realpathSync(fs.mkdtempSync(`${os.tmpdir()}/gc-overview-`))

interface Snap {
  status: string
  endedAt?: string
  seen?: { at?: string }
}

async function newSession(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/sessions', { headers, data: { agent: 'claude', cwd: ownDir() } })
  expect(res.ok()).toBe(true)
  return ((await res.json()) as { id: string }).id
}

async function send(request: APIRequestContext, id: string, text: string) {
  expect((await request.post(`/api/sessions/${id}/messages`, { headers, data: { text } })).ok()).toBe(true)
}

async function looked(request: APIRequestContext, id: string): Promise<boolean> {
  const s = (await (await request.get(`/api/sessions/${id}`, { headers })).json()) as Snap
  return s.status !== 'running' && !!s.endedAt && Date.parse(s.seen?.at ?? '') >= Date.parse(s.endedAt)
}

const overviewOf = (page: Page) => page.getByRole('region', { name: 'Overview', exact: true })
const row = (page: Page, title: string) => page.locator('button.session', { hasText: title })

async function toWorkspace(page: Page) {
  if (test.info().project.name === 'mobile') await showPane(page, 'Sessions')
  else await page.getByRole('radio', { name: 'Agents' }).click()
  await expect(overviewOf(page)).toHaveCount(0)
}

test('Overview results follow the seen state the sidebar shows, across reloads', async ({ page }, info) => {
  const title = `overview news ${info.project.name} ${Date.now()}`
  const id = await newSession(page.request)
  await page.goto(`/overview?token=${token}`)
  const overview = overviewOf(page)
  await expect(overview.getByRole('heading', { name: 'Overview' })).toBeVisible()
  await send(page.request, id, title)
  const card = overview.locator('.attention-session', { hasText: title })
  await expect(card.locator('.attention-outcome')).toHaveText('Done')
  await expect(card.locator('.attention-outcome')).toHaveCSS('font-family', /PT Mono/)
  await expect(card.locator('.attention-result')).toContainText(`echo: ${title}`)

  // A reload keeps the news: the server says nobody has looked.
  await page.reload()
  await expect(card.locator('.attention-outcome')).toHaveText('Done')
  await expect(card.getByLabel('Task elapsed')).toHaveText(/^\d+:\d\d$/)
  await toWorkspace(page)
  await expect(row(page, title).locator('.session-unseen')).toHaveText('new')

  // Dismiss is a look: the sidebar's mark goes too, and stays gone.
  await page.goto(`/overview?token=${token}`)
  await card.getByRole('button', { name: 'Dismiss result' }).click()
  await expect(card).toHaveCount(0)
  await expect.poll(() => looked(page.request, id)).toBe(true)
  await page.reload()
  await expect(overview.getByRole('heading', { name: 'Overview' })).toBeVisible()
  await expect(card).toHaveCount(0)
  await toWorkspace(page)
  await expect(row(page, title)).toBeVisible()
  await expect(row(page, title).locator('.session-unseen')).toHaveCount(0)

  // Reading the session in the workspace clears its result here.
  await send(page.request, id, 'and once more')
  await expect(row(page, title).locator('.session-unseen')).toHaveText('new')
  await row(page, title).click()
  await expect(page.locator('.item.assistant', { hasText: 'echo: and once more' })).toBeVisible()
  await expect.poll(() => looked(page.request, id)).toBe(true)
  await page.goto(`/overview?token=${token}`)
  await expect(overview.getByRole('heading', { name: 'Overview' })).toBeVisible()
  await expect(card).toHaveCount(0)
})

test('Overview follows new sessions live instead of refetching every transcript', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'traffic does not depend on the viewport')
  const stamp = Date.now()
  await page.goto(`/overview?token=${token}`)
  await expect(overviewOf(page).getByRole('heading', { name: 'Overview' })).toBeVisible()
  await expect(overviewOf(page).locator('.attention-summary')).toBeVisible()
  // Earlier specs' unseen results load once on arrival; count from here.
  await page.waitForTimeout(500)
  let fetches = 0
  page.on('request', (r) => {
    if (/\/api\/sessions\/[^/]+\/events/.test(r.url())) fetches++
  })
  const count = 6
  for (let i = 0; i < count; i++) {
    const id = await newSession(page.request)
    await send(page.request, id, `traffic ${stamp} ${i}`)
  }
  for (let i = 0; i < count; i++) {
    await expect(overviewOf(page).locator('.attention-session', { hasText: `traffic ${stamp} ${i}` }).locator('.attention-outcome')).toHaveText('Done')
  }
  // At most one look at each new session, not one per change of any.
  expect(fetches).toBeLessThanOrEqual(count)
})

test('Overview toggles back to the workspace and keeps workspace keys working', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'the top bar toggles are desktop controls')
  await page.goto(`/?token=${token}`)
  const toggle = page.getByRole('banner').getByRole('button', { name: 'Overview' })
  await expect(page.getByRole('banner').getByRole('button', { name: 'Focus', exact: true })).toBeVisible()
  await toggle.click()
  await expect(overviewOf(page)).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  const ink = await page.locator('h1').evaluate((el) => getComputedStyle(el).color)
  await expect(toggle).toHaveCSS('border-top-color', ink)
  await expect(page.getByRole('banner').getByRole('button', { name: 'Focus', exact: true })).toHaveCount(0)
  // A second click leaves.
  await toggle.click()
  await expect(overviewOf(page)).toHaveCount(0)
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  // So does the Agents tab.
  await toggle.click()
  await page.getByRole('radio', { name: 'Agents' }).click()
  await expect(overviewOf(page)).toHaveCount(0)
  // And f: the workspace returns in Focus.
  await toggle.click()
  await overviewOf(page).getByRole('heading', { name: 'Overview' }).click()
  await page.keyboard.press('f')
  await expect(overviewOf(page)).toHaveCount(0)
  await expect(page.getByRole('banner').getByRole('button', { name: 'Focus', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('banner').getByRole('button', { name: 'Focus', exact: true }).click()
})

test('a refused floating panel says so in a notice, not in the top bar', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'Document PiP is a desktop feature')
  await page.addInitScript(() => {
    Object.defineProperty(window, 'documentPictureInPicture', {
      configurable: true,
      value: { requestWindow: () => Promise.reject(new DOMException('Document PiP requires user activation and a long explanation that would overflow the bar', 'NotAllowedError')) },
    })
  })
  await page.goto(`/?token=${token}`)
  await page.getByRole('button', { name: 'Open floating panel' }).click()
  const notice = page.getByRole('alert').filter({ hasText: "Couldn't open the floating panel" })
  await expect(notice).toContainText('requires user activation')
  await expect(page.getByRole('banner').getByRole('alert')).toHaveCount(0)
  await notice.getByRole('button', { name: 'Dismiss' }).click()
  await expect(notice).toHaveCount(0)
})

test('Overview is dense on a desktop and plain on a phone', async ({ page }, info) => {
  const title = `a long job description that keeps going well past eight words so the card must cut it by its width ${info.project.name} ${Date.now()}`
  const id = await newSession(page.request)
  await page.goto(`/overview?token=${token}`)
  await send(page.request, id, title)
  const card = overviewOf(page).locator('.attention-session', { hasText: title })
  await expect(card.locator('.attention-outcome')).toHaveText('Done')
  const task = card.locator('.attention-task')
  await expect(task).toHaveAttribute('title', title)
  await expect(task).toHaveCSS('text-overflow', 'ellipsis')
  const line = await task.evaluate((el) => el.getBoundingClientRect().height)
  expect(line).toBeLessThan(info.project.name === 'mobile' ? 48 : 24)
  const sessions = overviewOf(page).getByRole('button', { name: 'Sessions' })
  if (info.project.name === 'mobile') {
    // The pane bar right below leads there already.
    await expect(sessions).toBeHidden()
  } else {
    await expect(sessions).toBeVisible()
    const height = await card.getByRole('button', { name: 'Open result' }).evaluate((el) => el.getBoundingClientRect().height)
    expect(height).toBeLessThan(44)
    const cardHeight = await card.evaluate((el) => el.getBoundingClientRect().height)
    expect(cardHeight).toBeLessThan(110)
  }
  await card.getByRole('button', { name: 'Dismiss result' }).click()
  await expect(card).toHaveCount(0)
})
