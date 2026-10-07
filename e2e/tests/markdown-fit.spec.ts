import { expect, test, type Page } from '@playwright/test'
import { token } from '../playwright.config'
import { openNewSession, showPane } from './pane'

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

// A three-column table on a phone: a long path in code must not take the
// column and crush the words beside it into one or two per line. The path
// breaks; words and numbers stay whole; what still does not fit scrolls in
// the table's own box, which fades at the edge it scrolls toward.
const TABLE = [
  'table',
  '',
  '| Path | Description | Risk |',
  '|---|---|---|',
  '| `internal/adapters/http/worktree_continue_handler.go` | Continues a worktree session after the folder was moved back into place | 1290 high |',
  '| `web/src/components/sessions/SessionList.tsx` | Reorders the list | low |',
].join('\n')

// tableFit measures the table as a phone shows it.
function tableFit(page: Page, name = 'table') {
  return page.locator('.item.assistant', { hasText: `echo: ${name}` }).locator('.md-table').evaluate((box) => {
    const words: string[] = []
    // a word (or number) outside code and paths is never cut across lines
    for (const td of box.querySelectorAll('td')) {
      const walk = document.createTreeWalker(td, NodeFilter.SHOW_TEXT)
      for (let n = walk.nextNode() as Text | null; n; n = walk.nextNode() as Text | null) {
        if (n.parentElement!.closest('code, .md-path')) continue
        const re = /\S+/g
        for (let m = re.exec(n.data); m; m = re.exec(n.data)) {
          const r = document.createRange()
          r.setStart(n, m.index)
          r.setEnd(n, m.index + m[0].length)
          const lines = new Set([...r.getClientRects()].map((q) => Math.round(q.top)))
          if (lines.size > 1) words.push(m[0])
        }
      }
    }
    const desc = box.querySelectorAll('tbody tr')[0].querySelectorAll('td')[1] as HTMLElement
    const style = getComputedStyle(box)
    return {
      words,
      descWidth: desc.getBoundingClientRect().width,
      overflows: box.scrollWidth > box.clientWidth + 1,
      fade: box.dataset.fade ?? '',
      mask: style.maskImage || style.webkitMaskImage,
      pageSideways: document.querySelector('.chat .scroll')!.scrollWidth - document.querySelector('.chat .scroll')!.clientWidth,
    }
  })
}

test('a three-column table with a long path reads on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 })
  await newSession(page)
  await page.getByLabel('Message').fill(TABLE)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.item.assistant', { hasText: 'echo: table' }).locator('table')).toBeVisible()
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 800 })
    await expect.poll(async () => (await tableFit(page)).words, { message: `${width} words` }).toEqual([])
    const fit = await tableFit(page)
    // the words beside the path keep a readable column
    expect(fit.descWidth, `${width} description`).toBeGreaterThanOrEqual(100)
    expect(fit.pageSideways, `${width} page`).toBeLessThanOrEqual(0)
    // a table that still scrolls says so at its edge
    if (fit.overflows) {
      expect(fit.fade, `${width} fade`).toContain('end')
      expect(fit.mask, `${width} mask`).not.toBe('none')
    } else expect(fit.fade, `${width} no fade`).toBe('')
  }
})

// The same with the path in plain text, first: it breaks between its
// folders rather than take its whole width, so the words beside it keep a
// readable column and the last column stays in view.
const PLAIN = [
  'plain paths',
  '',
  '| File | Change | Risk |',
  '|---|---|---|',
  '| internal/adapters/http/worktree_continue_handler.go | Continues a worktree session after the folder was moved back | high |',
  '| web/src/components/sessions/SessionList.tsx | Reorders the list | low |',
].join('\n')

test('a table whose first column holds a plain-text path reads on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 })
  await newSession(page)
  await page.getByLabel('Message').fill(PLAIN)
  await page.getByRole('button', { name: 'Send' }).click()
  const reply = page.locator('.item.assistant', { hasText: 'echo: plain paths' })
  await expect(reply.locator('table')).toBeVisible()
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 800 })
    await expect.poll(async () => (await tableFit(page, 'plain paths')).words, { message: `${width} words` }).toEqual([])
    const fit = await tableFit(page, 'plain paths')
    expect(fit.descWidth, `${width} change`).toBeGreaterThanOrEqual(100)
    expect(fit.pageSideways, `${width} page`).toBeLessThanOrEqual(0)
    // the Risk column is in the box's view, not behind its fade
    const risk = await reply.locator('.md-table').evaluate((box) => {
      const cell = box.querySelector('tbody td:last-child')!.getBoundingClientRect()
      return cell.right - box.getBoundingClientRect().right
    })
    expect(risk, `${width} risk`).toBeLessThanOrEqual(0)
  }
})

// A table too wide even with its paths broken scrolls, and fades on the
// side that still has more.
test('a wide table fades at the edge it scrolls toward', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 })
  await newSession(page)
  const wide = ['wide', '', '| a | b | c | d | e | f |', '|---|---|---|---|---|---|', '| alpha | bravo | charlie | delta | echo-echo | foxtrot |'].join('\n')
  await page.getByLabel('Message').fill(wide)
  await page.getByRole('button', { name: 'Send' }).click()
  const box = page.locator('.item.assistant', { hasText: 'echo: wide' }).locator('.md-table')
  await expect(box).toHaveAttribute('data-fade', 'end')
  await box.evaluate((el) => el.scrollTo({ left: el.scrollWidth }))
  await expect(box).toHaveAttribute('data-fade', 'start')
  await box.evaluate((el) => el.scrollTo({ left: 20 }))
  await expect(box).toHaveAttribute('data-fade', 'start end')
})

// A session is named after its first message as it reads: the sessions
// list and the chat header show no markdown syntax.
test('a session named from a markdown message reads plain', async ({ page }) => {
  await newSession(page)
  await page.getByLabel('Message').fill('Plan the **auth refactor** in `internal/app`')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.item.assistant', { hasText: 'echo: Plan' })).toBeVisible()
  await expect(page.locator('.chat-heading h2')).toHaveText('Plan the auth refactor in internal/app')
  await showPane(page, 'Sessions')
  await expect(page.locator('button.session', { hasText: 'Plan the auth refactor in internal/app' }).first()).toBeVisible()
})
