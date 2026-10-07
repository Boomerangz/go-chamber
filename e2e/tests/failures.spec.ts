import { expect, test, type Locator } from '@playwright/test'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { token } from '../playwright.config'

const headers = { Authorization: `Bearer ${token}` }

// expectRetryInline: Retry sits on the line the reason ends on, however
// the text wraps, not alone on a line below it.
async function expectRetryInline(failed: Locator) {
  const [last, retry] = await failed.evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let text: Text | null = null
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent?.trim() && !n.parentElement?.closest('button')) text = n as Text
    const range = document.createRange()
    const end = text!.textContent!.trimEnd().length
    range.setStart(text!, end - 1)
    range.setEnd(text!, end)
    const r = range.getBoundingClientRect()
    const b = el.querySelector('button')!.getBoundingClientRect()
    return [{ top: r.top, bottom: r.bottom }, { middle: b.top + b.height / 2 }]
  })
  expect(retry.middle).toBeGreaterThan(last.top)
  expect(retry.middle).toBeLessThan(last.bottom)
}

test('an open session keeps its header when the session list fails to load', async ({ page, isMobile }) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'gc-listfail-')))
  const res = await page.request.post('/api/sessions', { headers, data: { agent: 'claude', cwd: dir } })
  const { id } = (await res.json()) as { id: string }
  await page.route(/\/api\/sessions$/, (route) =>
    route.request().method() === 'GET' ? route.fulfill({ status: 500, body: 'database is locked' }) : route.fallback(),
  )
  await page.goto(`/s/${id}?token=${token}`)
  await expect(page.getByRole('heading', { level: 2, name: 'New Claude session' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Session', exact: true })).toHaveCount(0)
  if (!isMobile) {
    await expect(page.locator('.chat-path')).toContainText(path.basename(dir))
    const failed = page.locator('.load-failed', { hasText: "Couldn't load sessions: database is locked" })
    await expect(failed).toBeVisible()
    await expectRetryInline(failed)
  }
})

test('History says why it failed, in its own words, with Retry beside the reason', async ({ page }) => {
  let failing = true
  await page.route('**/api/history', (route) =>
    failing ? route.fulfill({ status: 500, body: 'permission denied reading ~/.claude/projects' }) : route.fallback(),
  )
  await page.goto(`/?token=${token}`)
  const bar = page.getByRole('navigation', { name: 'Views' })
  if (await bar.isVisible()) await bar.getByRole('button', { name: /^Sessions/ }).click()
  await page.locator('.history:not(.archived) > summary').click()
  const failed = page.locator('.load-failed', { hasText: "Couldn't load CLI sessions: permission denied" })
  await expect(failed).toBeVisible()
  await expectRetryInline(failed)
  failing = false
  await failed.getByRole('button', { name: 'Retry' }).click()
  await expect(failed).toHaveCount(0)
})
