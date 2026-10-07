import { expect, test, type Page } from '@playwright/test'
import { token } from '../playwright.config'
import { openNewSession } from './pane'

// Tablet and small-laptop widths (721–1100px): the shell fits the window with
// any dock open — nothing scrolls sideways, every top-bar control and the
// dock rail stay on screen, and the chat keeps a usable width.

async function newSession(page: Page) {
  await page.goto(`/?token=${token}`)
  await openNewSession(page)
  await page.getByLabel('Working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await page.getByLabel('Message').fill('hello tablet')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.item.assistant', { hasText: 'echo: hello tablet' })).toBeVisible()
}

async function openDock(page: Page, name: string) {
  const button = page.getByRole('toolbar', { name: 'Dock' }).getByRole('button', { name: new RegExp(`^${name}`) })
  if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click()
  await expect(button).toHaveAttribute('aria-pressed', 'true')
}

// offscreen lists what spills past the window's right edge, or scrolls it.
function offscreen(page: Page) {
  return page.evaluate(() => {
    const out: string[] = []
    const w = window.innerWidth
    if (document.documentElement.scrollWidth > w) out.push(`page ${document.documentElement.scrollWidth}`)
    const watch = ['.brand h1', '.topbar .show-sessions', '.mode-switch', '.topbar .focus-toggle', '.topbar .signout', '.dock-rail', '.layout > .chat']
    for (const s of watch) {
      const e = document.querySelector(s)
      if (!e) continue
      const r = e.getBoundingClientRect()
      if (r.width === 0) continue
      if (r.right > w + 0.5 || r.left < -0.5) out.push(`${s} ${Math.round(r.left)}..${Math.round(r.right)}`)
    }
    // the masthead's name stays on one line
    const h1 = document.querySelector('.brand h1')
    if (h1 && h1.getBoundingClientRect().height > 24) out.push('h1 wraps')
    return out
  })
}

test('no dock pushes the shell past the window at tablet widths', async ({ page, isMobile }) => {
  test.skip(isMobile, 'a phone shows one pane at a time')
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1280, height: 900 })
  await newSession(page)
  for (let width = 721; width <= 1001; width += 40) {
    await page.setViewportSize({ width, height: 900 })
    for (const name of ['Requests', 'Changes', 'Terminal']) {
      await openDock(page, name)
      await expect.poll(() => offscreen(page), { message: `${width} ${name}` }).toEqual([])
    }
  }
})

// A small laptop (up to 1100px): an open dock takes the sessions list's
// place, so the chat keeps a readable width beside it.
test('the chat keeps its room beside a dock on a small laptop', async ({ page, isMobile }) => {
  test.skip(isMobile, 'a phone shows one pane at a time')
  await page.setViewportSize({ width: 1280, height: 900 })
  await newSession(page)
  for (const width of [1024, 1100]) {
    await page.setViewportSize({ width, height: 800 })
    for (const name of ['Requests', 'Changes', 'Terminal']) {
      await openDock(page, name)
      await expect.poll(() => page.locator('.layout > .chat').evaluate((e) => e.getBoundingClientRect().width), { message: `${width} ${name}` }).toBeGreaterThanOrEqual(480)
    }
  }
  // wider, the sessions list stays beside the dock
  await page.setViewportSize({ width: 1280, height: 800 })
  await expect(page.locator('.layout > .sidebar')).toBeVisible()
})

// targets measures the controls a finger reaches for, smallest side first.
function targets(page: Page) {
  return page.evaluate(() => {
    const list = ['.session-menu-trigger', '.chat-header .rename-btn', '.chat-path-copy', '.rail-btn', '.folder-field .browse', '.composer .btn', '.topbar-end .btn-icon', '.new-session .btn-primary']
    const out: Record<string, number> = {}
    for (const s of list) {
      const e = document.querySelector(s)
      if (!e) continue
      const r = e.getBoundingClientRect()
      out[s] = Math.round(Math.min(r.width, r.height))
    }
    return out
  })
}

// A touch tablet keeps the wide layout but a finger's targets: every control
// at least 36px on its short side, and still nothing past the window.
test.describe('on a touch tablet', () => {
  test.use({ hasTouch: true })
  test('controls are finger-sized at tablet widths', async ({ page, isMobile }) => {
    test.skip(isMobile, 'a phone has these sizes by its width')
    await page.setViewportSize({ width: 1280, height: 900 })
    await newSession(page)
    for (const width of [768, 900, 1024]) {
      await page.setViewportSize({ width, height: 1000 })
      // the sessions list is shown (no dock open)
      await expect(page.locator('.layout > .sidebar')).toBeVisible()
      const sizes = await targets(page)
      expect(Object.keys(sizes).length, `${width}`).toBeGreaterThanOrEqual(7)
      for (const [what, side] of Object.entries(sizes)) expect(side, `${width} ${what}`).toBeGreaterThanOrEqual(36)
      // the bigger rename pencil still leaves the title whole before the usage line shows
      await expect
        .poll(() => page.locator('.chat-header').evaluate((el) => {
          const h2 = el.querySelector('.chat-heading h2')!
          const usage = el.querySelector('.usage')
          return !(usage && usage.getBoundingClientRect().width >= 1 && h2.scrollWidth > h2.clientWidth + 1)
        }), { message: `${width} title` })
        .toBe(true)
      for (const name of ['Requests', 'Changes', 'Terminal']) {
        await openDock(page, name)
        await expect.poll(() => offscreen(page), { message: `${width} ${name}` }).toEqual([])
      }
      await page.getByRole('toolbar', { name: 'Dock' }).getByRole('button', { name: /^Terminal/ }).click()
    }
  })
})

test('a mouse keeps the compact controls at tablet widths', async ({ page, isMobile }) => {
  test.skip(isMobile, 'a phone has finger-sized controls')
  await page.setViewportSize({ width: 900, height: 1000 })
  await newSession(page)
  const sizes = await targets(page)
  expect(sizes['.rail-btn']).toBeLessThan(36)
  expect(sizes['.folder-field .browse']).toBeLessThan(36)
})

test('Show sessions in the top bar is a named icon beside a dock', async ({ page, isMobile }) => {
  test.skip(isMobile, 'a phone shows one pane at a time')
  await page.setViewportSize({ width: 768, height: 1024 })
  await newSession(page)
  await openDock(page, 'Changes')
  const show = page.locator('.topbar .show-sessions')
  await expect(show).toBeVisible()
  await expect(show).toHaveAccessibleName('Show sessions')
  expect((await show.boundingBox())!.width).toBeLessThanOrEqual(40)
})
