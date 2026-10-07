import { devices, expect, test, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import { token } from '../playwright.config'
import { showPane } from './pane'

// The owner works from a laptop and a phone at once: what they read on one
// is not news on the other, and what nobody has read is news on both.

const headers = { Authorization: `Bearer ${token}` }
const ownDir = () => fs.realpathSync(fs.mkdtempSync(`${os.tmpdir()}/gc-devices-`))

interface Snap {
  id: string
  status: string
  endedAt?: string
  seen?: { item?: string; at?: string }
}

async function newSession(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/sessions', { headers, data: { agent: 'claude', cwd: ownDir() } })
  return ((await res.json()) as Snap).id
}

async function snapshot(request: APIRequestContext, id: string): Promise<Snap> {
  return (await (await request.get(`/api/sessions/${id}`, { headers })).json()) as Snap
}

// looked tells the server has heard of a look after the last turn ended.
async function looked(request: APIRequestContext, id: string): Promise<boolean> {
  const s = await snapshot(request, id)
  return s.status !== 'running' && !!s.endedAt && Date.parse(s.seen?.at ?? '') >= Date.parse(s.endedAt)
}

const row = (page: Page, title: string) => page.locator('button.session', { hasText: title })

test('what the owner read on one device is not new on the other', async ({ page, browser }, info) => {
  const title = `two devices ${info.project.name} ${Date.now()}`
  const shared = await newSession(page.request)
  const other = await newSession(page.request)

  // The laptop sits on another session while the phone works.
  await page.goto(`/s/${other}?token=${token}`)
  const phoneContext = await browser.newContext({ ...devices['Pixel 7'] })
  const phone = await phoneContext.newPage()
  await phone.goto(`/s/${shared}?token=${token}`)
  await phone.getByLabel('Message').fill(title)
  await phone.getByRole('button', { name: 'Send' }).click()
  await expect(phone.locator('.item.assistant', { hasText: `echo: ${title}` })).toBeVisible()
  await expect.poll(() => looked(page.request, shared)).toBe(true)

  // The laptop watched the turn end, but the phone read it.
  await showPane(page, 'Sessions')
  await expect(row(page, title)).toBeVisible()
  await expect(row(page, title)).not.toContainText('working')
  await expect(row(page, title).locator('.session-unseen')).toHaveCount(0)
  await expect(page.locator('.group', { has: row(page, title) }).locator('.group-unseen')).toHaveCount(0)
  await row(page, title).click()
  await expect(page.locator('.item.assistant', { hasText: `echo: ${title}` })).toBeVisible()
  await expect(page.locator('.unseen-mark')).toHaveCount(0)

  // Nobody looks while a turn ends: news on both.
  await page.goto(`/s/${other}?token=${token}`)
  await phone.goto(`/s/${other}?token=${token}`)
  const more = await page.request.post(`/api/sessions/${shared}/messages`, { headers, data: { text: 'more please' } })
  expect(more.ok()).toBe(true)
  await expect.poll(async () => (await snapshot(page.request, shared)).status).toBe('idle')
  for (const p of [page, phone]) {
    await showPane(p, 'Sessions')
    await expect(row(p, title).locator('.session-unseen')).toHaveText('new')
  }

  // The phone reads it; the laptop's mark goes without a reload.
  await row(phone, title).click()
  await expect(phone.locator('.item.assistant', { hasText: 'echo: more please' })).toBeVisible()
  await expect(row(page, title).locator('.session-unseen')).toHaveCount(0)
  await phoneContext.close()
})

// Sounds on everywhere, the chime plays once: on the page the owner was at
// last, whichever device it is on. Presence is server-wide, so a page of a
// spec running alongside may take "last" for a moment: the page that should
// sound is focused again before each try, and the other must stay silent.
test('a finished turn chimes only where the owner was last', async ({ page, browser, isMobile }) => {
  // It brings its own phone; two runs at once would take "last" from each other.
  test.skip(isMobile, 'the desktop run has a phone of its own')
  const listen = async (p: Page) => {
    await p.addInitScript(() => {
      localStorage.setItem('gc.sound', 'on')
      const w = window as unknown as { tones: number }
      w.tones = 0
      const create = AudioContext.prototype.createOscillator
      AudioContext.prototype.createOscillator = function () {
        w.tones++
        return create.call(this)
      }
    })
    await p.goto(`/?token=${token}`)
  }
  const tones = (p: Page) => p.evaluate(() => (window as unknown as { tones: number }).tones)
  // A focus event says "the owner is here", as switching to the page does.
  const focus = (p: Page) => p.evaluate(() => window.dispatchEvent(new Event('focus')))
  const phoneContext = await browser.newContext({ ...devices['Pixel 7'] })
  const phone = await phoneContext.newPage()
  await listen(page)
  await listen(phone)
  const id = await newSession(page.request)
  let turns = 0
  const finish = async () => {
    const was = (await snapshot(page.request, id)).endedAt ?? ''
    const sent = await page.request.post(`/api/sessions/${id}/messages`, { headers, data: { text: `chime check ${++turns}` } })
    expect(sent.ok()).toBe(true)
    await expect.poll(async () => (await snapshot(page.request, id)).endedAt ?? '').not.toBe(was)
  }
  const chimesOn = async (here: Page, silent: Page) => {
    const quiet = await tones(silent)
    await expect
      .poll(async () => {
        await focus(here)
        const before = await tones(here)
        await finish()
        // Chimes within 600ms of each other make one sound.
        await here.waitForTimeout(700)
        return (await tones(here)) > before
      }, { timeout: 20_000 })
      .toBe(true)
    expect(await tones(silent)).toBe(quiet)
  }

  await chimesOn(page, phone)
  // The owner picks up the phone.
  await chimesOn(phone, page)
  await phoneContext.close()
})
