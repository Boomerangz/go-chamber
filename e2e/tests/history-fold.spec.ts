import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import { token } from '../playwright.config'

const headers = { Authorization: `Bearer ${token}` }

// A list taller than the sidebar still says History is there: its heading
// stays pinned at the foot of the scrolling list, until it is opened.
test('History’s heading shows at the foot of a long session list at 1280x800', async ({ page, isMobile }) => {
  test.skip(isMobile, 'a laptop size')
  const root = fs.realpathSync(fs.mkdtempSync(`${os.tmpdir()}/gc-fold-`))
  const ids: string[] = []
  for (const name of ['alpha', 'beta', 'work']) {
    fs.mkdirSync(`${root}/${name}`)
    for (let i = 0; i < 3; i++) {
      const r = await page.request.post('/api/sessions', { headers, data: { agent: 'claude', cwd: `${root}/${name}` } })
      ids.push(((await r.json()) as { id: string }).id)
    }
  }
  await page.request.post(`/api/sessions/${ids[0]}/archive`, { headers })
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/?token=${token}`)
  const body = page.locator('.sidebar-body')
  await expect(page.locator('.history.archived > summary')).toBeAttached()
  // the list is longer than the sidebar shows
  expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)

  const summary = page.locator('.history:not(.archived) > summary')
  const seen = () =>
    summary.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const box = el.closest('.sidebar-body')!.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + 20, r.top + r.height / 2)
      return r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5 && el.contains(hit)
    })
  expect(await seen()).toBe(true)
  // halfway down the list it is still there; at the end it sits after Archived
  await body.evaluate((el) => (el.scrollTop = el.scrollHeight / 3))
  expect(await seen()).toBe(true)
  await body.evaluate((el) => (el.scrollTop = el.scrollHeight))
  expect(await seen()).toBe(true)
  const archived = await page.locator('.history.archived > summary').boundingBox()
  const history = await summary.boundingBox()
  expect(history!.y).toBeGreaterThanOrEqual(archived!.y + archived!.height)

  // Opened, it reads as before: the list of CLI sessions under its heading.
  await summary.click()
  await expect(page.locator('.history:not(.archived)')).toHaveAttribute('open', '')
  await expect(summary).toBeInViewport()
})
