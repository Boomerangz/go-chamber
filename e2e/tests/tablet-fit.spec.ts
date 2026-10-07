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
    // the new-session form folds once a session starts; its controls are measured open
    await openNewSession(page)
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

// A long folder shows its end, the project name; the glyph cut at the
// field's left edge fades instead of standing there half drawn.
test('a folder path scrolled to its end fades at its left edge', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1000 })
  await page.goto(`/?token=${token}`)
  await openNewSession(page)
  const input = page.getByLabel('Working directory')
  const field = page.locator('.folder-field', { has: input })
  await input.fill('/Users/someone/projects/clients/acme/services/backend/api-server')
  await input.blur()
  await expect(field).toHaveAttribute('data-fade', 'start')
  expect(await input.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0)
  expect(await input.evaluate((el) => getComputedStyle(el).maskImage)).not.toBe('none')  // a short path is whole: no fade
  await input.fill('/tmp')
  await input.blur()
  await expect(field).not.toHaveAttribute('data-fade')
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

// overlaps lists the top bar's parts that draw over one another: the
// masthead, Show sessions, each mode and each control at the bar's end
// (the health mark among them), and any word cut inside its own control.
function overlaps(page: Page) {
  return page.evaluate(() => {
    const out: string[] = []
    const parts: [string, DOMRect][] = []
    const add = (name: string, e: Element | null) => {
      if (!e) return
      const r = e.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) return
      parts.push([name, r])
      // every word shown inside stays inside (a label kept only for its
      // name, 1px and clipped, is not shown)
      const walk = document.createTreeWalker(e, NodeFilter.SHOW_TEXT)
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        if (n.parentElement!.getBoundingClientRect().width <= 1) continue
        const range = document.createRange()
        range.selectNodeContents(n)
        const t = range.getBoundingClientRect()
        if (t.width > 0 && (t.right > r.right + 0.5 || t.left < r.left - 0.5)) out.push(`${name} cut`)
      }
    }
    add('h1', document.querySelector('.topbar .brand h1'))
    add('show-sessions', document.querySelector('.topbar .show-sessions'))
    for (const b of document.querySelectorAll('.topbar .mode-switch [role="radio"]')) add(`mode ${b.textContent}`, b)
    for (const c of document.querySelectorAll('.topbar-end > *')) add(`end ${c.className || c.tagName}`, c)
    for (let i = 0; i < parts.length; i++)
      for (let j = i + 1; j < parts.length; j++) {
        const [a, ra] = parts[i]
        const [b, rb] = parts[j]
        if (ra.right > rb.left + 0.5 && rb.right > ra.left + 0.5 && ra.bottom > rb.top + 0.5 && rb.bottom > ra.top + 0.5) out.push(`${a} over ${b}`)
      }
    if (document.documentElement.scrollWidth > window.innerWidth) out.push(`page ${document.documentElement.scrollWidth}`)
    return out
  })
}

// A touch tablet with a dock open: the dock takes the sessions list's place,
// Show sessions joins the bar, and its finger-sized controls still sit side
// by side — no mode under Show sessions, no health mark over Diagnostics.
test.describe('the top bar of a touch tablet', () => {
  test.use({ hasTouch: true })
  test('nothing in the bar draws over anything else with a dock open', async ({ page, isMobile }) => {
    test.skip(isMobile, 'a phone has its own bar')
    test.setTimeout(120_000)
    // a shell runs: the Terminal mode carries its count (and a request waits)
    const headers = { Authorization: `Bearer ${token}` }
    const made = await page.request.post('/api/sessions', { headers, data: { agent: 'claude', cwd: '/tmp' } })
    const { id } = (await made.json()) as { id: string }
    await page.request.post(`/api/sessions/${id}/messages`, { headers, data: { text: 'please permission' } })
    const term = await page.request.post('/api/terminals', { headers, data: { cwd: '/tmp', cols: 80, rows: 24 } })
    const { id: termId } = (await term.json()) as { id: string }
    await page.setViewportSize({ width: 1280, height: 900 })
    await newSession(page)
    const modes = page.getByRole('radiogroup', { name: 'Mode' })
    await expect(modes.locator('.count')).toBeVisible()
    for (const width of [721, 768, 820, 900, 960, 961, 1024, 1100]) {
      await page.setViewportSize({ width, height: 1180 })
      for (const name of ['Requests', 'Changes']) {
        await openDock(page, name)
        await expect.poll(() => overlaps(page), { message: `${width} ${name}` }).toEqual([])
      }
    }
    // Overview drops Focus but keeps its own toggle pressed
    await page.setViewportSize({ width: 820, height: 1180 })
    await page.locator('.topbar .overview-toggle').click()
    await expect(page.locator('.topbar .overview-toggle')).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => overlaps(page), { message: 'overview' }).toEqual([])
    await page.request.delete(`/api/terminals/${termId}`, { headers })
  })
})
