import { expect, test, type Page } from '@playwright/test'
import { token } from '../playwright.config'
import { openNewSession, showSessionDetails } from './pane'

// Shared visual rules that jsdom can't see: computed styles, sizes and
// contrast in the real browser.

// contrastOf measures a border (or text) colour against the sheet, as WCAG does.
async function contrastOf(page: Page, selector: string, prop: 'borderTopColor' | 'color') {
  return page.locator(selector).first().evaluate((el, prop) => {
    const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
      return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!)
    }
    const fg = lum(rgb(getComputedStyle(el)[prop as 'color']))
    const bg = lum(rgb(getComputedStyle(document.body).backgroundColor))
    return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)
  }, prop)
}

test('a disabled button stays quiet: no border on a ghost, no hover', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', 'hover is a pointer matter')
  await page.goto(`/?token=${token}`)
  await page.locator('.topbar-end').waitFor()
  await page.evaluate(() => {
    const box = document.createElement('div')
    box.id = 'probe'
    box.style.cssText = 'position:fixed;left:200px;top:200px;z-index:99;display:flex;gap:8px;background:var(--paper);padding:8px'
    box.innerHTML =
      '<button class="btn btn-ghost" disabled>Ghost</button><button class="btn" disabled>Plain</button>' +
      '<button class="btn btn-danger" disabled>Danger</button><button class="btn btn-ghost">Live</button>'
    document.body.append(box)
  })
  const style = (name: string) =>
    page.getByRole('button', { name, exact: true }).evaluate((el) => {
      const s = getComputedStyle(el)
      return { border: s.borderTopColor, background: s.backgroundColor }
    })
  expect((await style('Ghost')).border).toBe('rgba(0, 0, 0, 0)')
  // past the 120ms colour transition, a hovered disabled button looks the same
  const settled = async (name: string) => {
    await page.getByRole('button', { name, exact: true }).hover({ force: true })
    await page.waitForTimeout(200)
    return style(name)
  }
  const plain = await style('Plain')
  expect(await settled('Plain')).toEqual(plain)
  const danger = await style('Danger')
  expect(await settled('Danger')).toEqual(danger)
  // an enabled ghost still answers the pointer
  expect((await settled('Live')).border).not.toBe('rgba(0, 0, 0, 0)')
})

for (const scheme of ['light', 'dark'] as const) {
  test(`field edges and request counts read clearly (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await page.goto(`/?token=${token}`)
    await openNewSession(page)
    // a field's edge is what shows where to type: at least 3:1 against the sheet
    expect(await contrastOf(page, '.folder-field', 'borderTopColor')).toBeGreaterThanOrEqual(3)
    // a request count is small text on amber: at least 4.5:1
    const count = await page.evaluate(() => {
      const b = document.createElement('span')
      b.className = 'badge'
      b.id = 'probe-badge'
      b.textContent = '2'
      document.body.append(b)
      return true
    })
    expect(count).toBe(true)
    const ratio = await page.locator('#probe-badge').evaluate((el) => {
      const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
      const lum = ([r, g, b]: number[]) => {
        const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
        return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!)
      }
      const s = getComputedStyle(el)
      const [a, b] = [lum(rgb(s.color)), lum(rgb(s.backgroundColor))]
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
    })
    expect(ratio).toBeGreaterThanOrEqual(4.5)
  })
}

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' })
  test('a quick lookup still never flashes "searching…"', async ({ page }) => {
    await page.goto(`/?token=${token}`)
    await page.locator('.topbar-end').waitFor()
    const hiddenAtFirst = await page.evaluate(() => {
      const note = document.createElement('div')
      note.className = 'completions-note searching'
      note.id = 'probe-note'
      note.textContent = 'searching…'
      document.body.append(note)
      return getComputedStyle(note).visibility
    })
    expect(hiddenAtFirst).toBe('hidden')
    await expect(page.locator('#probe-note')).toBeVisible()
  })
})

test('the health mark stands apart from the toggles after it', async ({ page, isMobile }) => {
  test.skip(isMobile, 'a phone draws no mark for a working connection (phone-room.spec)')
  await page.goto(`/?token=${token}`)
  const health = page.locator('.topbar-end > .health')
  await expect(health).toBeVisible()
  expect(await health.evaluate((el) => getComputedStyle(el).borderRightWidth)).toBe('1px')
})

test('diagnostic metrics are framed, so a bad one can turn red', async ({ page }) => {
  await page.goto(`/diagnostics?token=${token}`)
  const metric = page.locator('.diagnostic-metric').first()
  await expect(metric).toBeVisible()
  expect(await metric.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('1px')
})

test('phone controls are finger-sized', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'phone layout only')
  await page.goto(`/?token=${token}`)
  await openNewSession(page)
  const sizeOf = (selector: string) =>
    page.locator(selector).first().evaluate((el) => {
      const r = el.getBoundingClientRect()
      return { w: Math.round(r.width), h: Math.round(r.height) }
    })
  for (const selector of ['.notify-toggle', '.sound-toggle']) {
    const { w, h } = await sizeOf(selector)
    expect(w, selector).toBeGreaterThanOrEqual(36)
    expect(h, selector).toBeGreaterThanOrEqual(36)
  }
  expect((await sizeOf('.new-session .segmented button')).h).toBeGreaterThanOrEqual(36)

  await page.getByLabel('Working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await page.getByLabel('Message').fill('edit some files')
  await page.getByRole('button', { name: 'Send' }).click()
  // finished tool lines fold into one summary line, once the turn is over:
  // while it runs the transcript is still rearranging them (measured then,
  // on a busy machine, the first summary had no box at all)
  await expect(page.getByRole('listitem', { name: 'Turn usage' })).toBeVisible()
  const fold = page.locator('.items summary').first()
  await expect(fold).toBeVisible()
  expect((await sizeOf('.items summary')).h).toBeGreaterThanOrEqual(36)
  await showSessionDetails(page)
  for (const selector of ['.chat-path-copy', '.model-button', 'select.field-sm']) {
    const { h } = await sizeOf(selector)
    expect(h, selector).toBeGreaterThanOrEqual(36)
  }
})
