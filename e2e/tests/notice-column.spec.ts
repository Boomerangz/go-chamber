import { expect, test, type Page } from '@playwright/test'
import { token } from '../playwright.config'
import { openNewSession, showPane } from './pane'

async function newSession(page: Page) {
  await page.goto(`/?token=${token}`)
  await showPane(page, 'Sessions')
  await openNewSession(page)
  await page.getByLabel('Working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByLabel('Message')).toBeVisible()
}

type Box = { x: number; y: number; width: number; height: number }
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

// A notice never sits on a control: not on the first message's Copy/Reuse,
// not on the transcript column at all. It takes the margin right of the
// column when that fits, else the transcript's end above the composer.
for (const width of [1440, 1920]) {
  test(`a notice keeps off the transcript column at ${width}px`, async ({ page, isMobile }) => {
    test.skip(isMobile, 'desktop widths')
    await page.setViewportSize({ width, height: 900 })
    await newSession(page)
    await page.getByLabel('Message').fill('first words')
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(page.locator('.item.assistant', { hasText: 'echo: first words' })).toBeVisible()
    await page.route('**/api/sessions/*/messages', (route) => route.fulfill({ status: 500, body: 'agent unavailable' }))
    await page.getByLabel('Message').fill('will fail')
    await page.getByRole('button', { name: 'Send' }).click()
    const toast = page.locator('.toast-error').first()
    await expect(toast).toBeVisible()

    const message = page.locator('.item.user').first()
    await message.hover()
    const actions = (await message.locator('.msg-actions').boundingBox())!
    const box = (await toast.boundingBox())!
    expect(overlaps(box, actions)).toBe(false)
    const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.closest('.notices') !== null, [actions.x + actions.width / 2, actions.y + actions.height / 2])
    expect(hit).toBe(false)
    const composer = (await page.locator('.composer').boundingBox())!
    expect(overlaps(box, composer)).toBe(false)
    const column = (await page.locator('.items').boundingBox())!
    if (width >= 1920) {
      // Room beside the column: the notice sits in the margin, at the top.
      expect(box.x).toBeGreaterThanOrEqual(column.x + column.width)
      expect(box.y).toBeLessThan(column.y + 100)
    } else {
      // No room: at the transcript's end, just above what follows it.
      expect(box.y + box.height).toBeGreaterThan(composer.y - 120)
    }
  })
}
