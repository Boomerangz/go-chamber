import { expect, test, type Page } from '@playwright/test'
import { token } from '../playwright.config'
import { openNewSession } from './pane'

async function newSession(page: Page) {
  await page.goto(`/?token=${token}`)
  await openNewSession(page)
  await page.getByLabel('Working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByLabel('Message')).toBeVisible()
}

// The fake agent echoes the message back, so the reply is this markdown.
const REPLY = [
  'report',
  '',
  '# A heading in the reply that is long enough to need more than one line on a phone screen',
  '',
  '| File | Lines | Comment that is quite long and does not fit |',
  '|---|---:|---|',
  '| `web/src/components/ChatView/Transcript.tsx` | 1290 | a long file, worth splitting into parts |',
  '',
  '![chart](https://example.invalid/chart.png)',
  '',
  '![shot](/tmp/go-chamber-no-such-image.png)',
].join('\n')

test('a reply with a heading, a table and images fits the column', async ({ page }) => {
  const remote: string[] = []
  page.on('request', (r) => {
    if (r.url().includes('example.invalid')) remote.push(r.url())
  })
  await newSession(page)
  await page.getByLabel('Message').fill(REPLY)
  await page.getByRole('button', { name: 'Send' }).click()
  const reply = page.locator('.item.assistant', { hasText: 'echo: report' })
  await expect(reply.locator('table')).toBeVisible()

  // The heading is the sans and wraps: it is no masthead.
  const heading = reply.locator('h1')
  const look = await heading.evaluate((el) => {
    const cs = getComputedStyle(el)
    return { mono: cs.fontFamily.includes('PT Mono'), wrap: cs.whiteSpace, lines: el.getBoundingClientRect().height / parseFloat(cs.lineHeight) }
  })
  expect(look.mono).toBe(false)
  expect(look.wrap).toBe('normal')
  expect(await page.locator('.brand h1').evaluate((el) => getComputedStyle(el).fontFamily)).toContain('PT Mono')

  // A number in a cell stays whole on one line; the table scrolls in its own box.
  const cell = reply.locator('td', { hasText: '1290' })
  const box = await cell.evaluate((el) => {
    const range = document.createRange()
    range.selectNodeContents(el)
    return { rects: range.getClientRects().length }
  })
  expect(box.rects).toBe(1)

  // A remote image is a link, never fetched; a missing local one says so.
  await expect(reply.getByRole('link', { name: /image: chart/ })).toHaveAttribute('href', 'https://example.invalid/chart.png')
  await expect(reply.locator('.md-image-missing')).toHaveText(/image: shot · couldn't load/)
  expect(remote).toEqual([])

  // Nothing pushes the transcript sideways.
  const scroll = page.locator('.chat .scroll')
  const sideways = await scroll.evaluate((el) => el.scrollWidth - el.clientWidth)
  expect(sideways).toBeLessThanOrEqual(0)
})
