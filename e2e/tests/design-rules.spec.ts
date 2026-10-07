import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { token } from '../playwright.config'
import { openNewSession, showPane } from './pane'

// DESIGN.md's shared rules, checked where jsdom can't: one look for a
// choice, one disabled style, one way to draw keys, mono for what labels.

const headers = { Authorization: `Bearer ${token}` }

async function newSession(page: Page) {
  await page.goto(`/?token=${token}`)
  await openNewSession(page)
  await page.getByLabel('Working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByLabel('Message')).toBeVisible()
}

async function say(page: Page, text: string) {
  await page.getByLabel('Message').fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
}

const box = (l: Locator) => l.evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect)

// look is what a choice control draws: its own square, never the browser's.
function look(l: Locator) {
  return l.evaluate((el) => {
    const s = getComputedStyle(el)
    return {
      appearance: s.appearance,
      radius: s.borderTopLeftRadius,
      width: el.getBoundingClientRect().width,
      background: s.backgroundColor,
      sheet: getComputedStyle(document.body).backgroundColor,
    }
  })
}

for (const scheme of ['light', 'dark'] as const) {
  test(`a question's options and a checkbox are DESIGN's squares, not the browser's (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await newSession(page)
    // the new-session checkbox: an empty square on the sheet
    await showPane(page, 'Sessions')
    await openNewSession(page)
    const check = page.getByRole('checkbox', { name: /In a new worktree/ })
    const unchecked = await look(check)
    expect(unchecked.appearance).toBe('none')
    expect(unchecked.radius).toBe('1px')
    expect(unchecked.background).toBe(unchecked.sheet)
    await showPane(page, 'Chat')

    await say(page, 'ask me something')
    const alpha = page.getByRole('radio', { name: /Alpha/ })
    const beta = page.getByRole('radio', { name: /Beta/ })
    await expect(alpha).toBeVisible()
    const rest = await look(beta)
    expect(rest.appearance).toBe('none')
    expect(rest.radius).toBe('1px')
    expect(rest.width).toBeLessThanOrEqual(14)
    // unchecked is the sheet itself: nothing that reads as chosen
    expect(rest.background).toBe(rest.sheet)
    await beta.click()
    await expect(beta).toBeChecked()
    // past the colour transition, a checked one is filled
    await expect.poll(async () => (await look(beta)).background).not.toBe(rest.sheet)
    // still a native radio group: the arrows move the choice
    await beta.focus()
    await page.keyboard.press('ArrowUp')
    await expect(alpha).toBeChecked()
  })
}

test('terminal mode: Browse stays a small button inside the folder field', async ({ page }) => {
  await page.goto(`/terminal?token=${token}`)
  const field = page.locator('.new-terminal .folder-field')
  await expect(field).toBeVisible()
  const browse = field.getByRole('button', { name: /Browse/ })
  const [f, b] = [await box(field), await box(browse)]
  expect(b.width).toBeLessThan(90)
  expect(f.right - b.right).toBeLessThan(12)
})

test('the requests tray fits Allow, Allow for session and Deny on one row', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the desktop dock')
  await page.setViewportSize({ width: 1440, height: 900 })
  await newSession(page)
  // the tray lists every session's requests on the one server: this test's
  // row is found by its session's title, not as whichever row is first
  const title = `tray row ${Date.now()}: please permission`
  await say(page, title)
  await expect(page.locator('.request.permission')).toBeVisible()
  await page.getByRole('toolbar', { name: 'Dock' }).getByRole('button', { name: /^Requests/ }).click()
  const actions = page
    .getByRole('complementary', { name: 'Pending requests' })
    .locator('li')
    .filter({ has: page.locator('.request-session', { hasText: title }) })
    .locator('.tray-actions')
  await expect(actions.getByRole('button', { name: 'Deny' })).toBeVisible()
  const tops = await actions.locator('button').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)))
  expect(tops.length).toBe(3)
  expect(new Set(tops).size).toBe(1)
})

test('a gone folder reads as a label, the path in mono on its own line, then why', async ({ page }, info) => {
  const cwd = path.join(realpathSync(mkdtempSync(path.join(tmpdir(), 'gc-e2e-'))), `gone-rules-${info.project.name}`)
  mkdirSync(cwd)
  const made = (await (await page.request.post('/api/sessions', { headers, data: { agent: 'claude', cwd } })).json()) as { id: string }
  await page.goto(`/s/${made.id}?token=${token}`)
  await expect(page.getByLabel('Message')).toBeVisible()
  rmSync(cwd, { recursive: true, force: true })
  await say(page, 'hello?')
  const gone = page.getByRole('group', { name: 'Folder gone' })
  await expect(gone).toBeVisible()
  // no separator left hanging at a line's end
  expect(await gone.locator('p').first().innerText()).not.toMatch(/·\s*$/m)
  const kw = gone.locator('.worktree-gone-kw')
  const where = gone.locator('.gone-path')
  const why = gone.locator('.gone-why')
  await expect(why).toHaveText(/no longer exists/)
  expect((await box(where)).top).toBeGreaterThanOrEqual((await box(kw)).bottom - 1)
  expect((await box(why)).top).toBeGreaterThanOrEqual((await box(where)).bottom - 1)
  expect(await where.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/PT Mono/)
})

test('folded output and diff summaries are mono like the lines beside them', async ({ page }) => {
  await newSession(page)
  await say(page, 'edit some files')
  await expect(page.locator('.item.assistant', { hasText: 'edited a.go' })).toBeVisible()
  const diff = page.locator('.item.file .item-output > summary').first()
  expect(await diff.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/PT Mono/)
})

test('key hints: one key per box, the same gap before their words', async ({ page, isMobile }) => {
  test.skip(isMobile, 'a touch screen shows no key hints')
  await newSession(page)
  // the gap between a hint's last box and its word, in the composer and the switcher
  const gapAfter = (l: Locator) =>
    l.evaluate((el) => {
      const keys = el.querySelectorAll('kbd')
      const last = keys[keys.length - 1]!
      const word = el.querySelector('.keys-label')!
      return Math.round(word.getBoundingClientRect().left - last.getBoundingClientRect().right)
    })
  const composer = await gapAfter(page.locator('.composer-keys .keys').first())
  await page.keyboard.press('ControlOrMeta+k')
  const switcher = await gapAfter(page.locator('.switcher-foot .keys').first())
  expect(composer).toBeGreaterThanOrEqual(3)
  expect(composer).toBe(switcher)
  await page.keyboard.press('Escape')
})

test('a subagent’s Stop is a bordered danger button right after its line', async ({ page }) => {
  await newSession(page)
  await say(page, 'run a subagent')
  const stop = page.locator('.subagent .stop-task')
  await expect(stop).toBeVisible()
  expect(await stop.evaluate((el) => el.classList.contains('btn-danger'))).toBe(true)
  expect(await stop.evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe('solid')
  const head = await box(page.locator('.subagent .subagent-head').first())
  const s = await box(stop)
  // not pushed to the far edge of the column
  expect(head.right - s.right).toBeGreaterThan(40)
})

test('disabled controls are ink-3 on a rule border, never faded or filled', async ({ page }) => {
  await page.goto(`/?token=${token}`)
  await page.locator('.topbar-end').waitFor()
  await page.evaluate(() => {
    const box = document.createElement('div')
    box.id = 'probe'
    box.style.cssText = 'position:fixed;left:200px;top:200px;z-index:99;display:flex;gap:8px;background:var(--paper);padding:8px'
    box.innerHTML =
      '<button class="btn btn-primary" disabled>Primary</button><button class="btn" disabled>Plain</button>' +
      '<div class="segmented"><button disabled>Seg</button><button>Live</button></div><button class="rail-btn" disabled>R</button>'
    document.body.append(box)
  })
  const style = (name: string) =>
    page.getByRole('button', { name, exact: true }).evaluate((el) => {
      const s = getComputedStyle(el)
      return { color: s.color, background: s.backgroundColor, border: s.borderTopColor, opacity: s.opacity }
    })
  const plain = await style('Plain')
  const primary = await style('Primary')
  expect(primary.color).toBe(plain.color)
  expect(primary.border).toBe(plain.border)
  expect(primary.background).toBe(plain.background)
  for (const name of ['Seg', 'R']) {
    const s = await style(name)
    expect(s.opacity, name).toBe('1')
    expect(s.color, name).toBe(plain.color)
  }
  // a live segment is not drawn like a disabled one
  expect((await style('Live')).color).not.toBe(plain.color)
})

test('a count on a mode tab moves no tab', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the centred desktop switch')
  await page.addInitScript(() => Object.defineProperty(window, 'RTCPeerConnection', { value: undefined }))
  const term = await page.request.post('/api/terminals', { headers, data: { cwd: '/tmp', cols: 80, rows: 24 } })
  const { id } = (await term.json()) as { id: string }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`/?token=${token}`)
  const modes = page.getByRole('radiogroup', { name: 'Mode' })
  await expect(modes.locator('.count')).toBeVisible()
  const labels = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.mode-switch [role="radio"]')].map((b) => {
        const r = document.createRange()
        r.selectNodeContents(b.firstChild!)
        return Math.round(r.getBoundingClientRect().left)
      }),
    )
  const counted = await labels()
  await page.addStyleTag({ content: '.mode-switch .count, .mode-switch .badge { display: none !important; }' })
  expect(await labels()).toEqual(counted)
  // and the count stays on its own tab
  await page.addStyleTag({ content: '.mode-switch .count { display: inline-grid !important; }' })
  const tab = await box(modes.getByRole('radio', { name: /^Terminal/ }))
  const count = await box(modes.locator('.count'))
  expect(count.left).toBeGreaterThanOrEqual(tab.left)
  expect(count.right).toBeLessThanOrEqual(tab.right + 0.5)
  await page.request.delete(`/api/terminals/${id}`, { headers })
})

test('"No changes" lines up with the CHANGES label', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the desktop dock')
  await page.setViewportSize({ width: 1440, height: 900 })
  const repo = realpathSync(mkdtempSync(path.join(tmpdir(), 'gc-e2e-')))
  const { execFileSync } = await import('node:child_process')
  execFileSync('git', ['init', '-q', repo])
  await page.goto(`/?token=${token}`)
  await openNewSession(page)
  await page.getByLabel('Working directory').fill(repo)
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByLabel('Message')).toBeVisible()
  await page.getByRole('toolbar', { name: 'Dock' }).getByRole('button', { name: /^Changes/ }).click()
  const panel = page.getByRole('region', { name: 'Changes' })
  const none = panel.getByText('No changes', { exact: true })
  await expect(none).toBeVisible()
  const label = await box(panel.locator('.section-title').first())
  expect(Math.abs((await box(none)).left - label.left)).toBeLessThanOrEqual(1)
})

test('a permission card that takes focus draws one frame, not a ring around its border', async ({ page, isMobile }) => {
  test.skip(isMobile, 'a touch screen focuses no card')
  await newSession(page)
  await say(page, 'please permission')
  const card = page.locator('.request.permission')
  await expect(card).toBeFocused()
  expect(await card.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('none')
  // the focus still shows: its own frame doubles
  expect(await card.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe('none')
  await page.waitForTimeout(700)
  await page.keyboard.press('d')
  await expect(page.getByLabel('Deny reason')).toBeVisible()
})

// The type scale: few steps, far enough apart to carry different jobs. The
// session title reads as the document's title, the REQUIRES block as the one
// thing that needs you; the chrome uses the scale's sizes and nothing between.
const SCALE = ['11px', '11.5px', '12px', '13px', '14px', '15px', '16px', '18px', '20px', '26px', '32px']

test('type keeps to the scale, the session title and the REQUIRES title lead', async ({ page, isMobile }) => {
  await newSession(page)
  await say(page, 'please permission')
  await expect(page.locator('.request.permission')).toBeVisible()
  const size = (sel: string) => page.locator(sel).first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
  const transcript = await size('.item.user, .row-user_message .item')
  expect(await size('.chat-heading h2')).toBeGreaterThanOrEqual(isMobile ? 20 : 26)
  expect(await size('.chat-heading h2')).toBeGreaterThan(transcript * (isMobile ? 1.3 : 1.7))
  expect(await size('.request-title')).toBeGreaterThanOrEqual(18)
  expect(await size('.request-kw')).toBeGreaterThanOrEqual(13)
  const off = await page.evaluate((scale) => {
    const out = new Set<string>()
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      if (el.closest('.md, pre, code, kbd, .xterm, svg, .sr-only') || !el.childNodes.length) continue
      const text = [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim())
      if (!text || !el.getClientRects().length) continue
      const fs = getComputedStyle(el).fontSize
      if (!scale.includes(fs)) out.add(`${fs} ${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`)
    }
    return [...out]
  }, SCALE)
  expect(off).toEqual([])
})

// Quiet chrome: the new-session form is one line until asked for, and amber
// is rationed to what needs the owner: the REQUIRES block and the counts.
// A waiting session's state word is ink like every other state, and Allow
// inside the block is ink, so the block holds one hue.
test('the new-session form folds to a line until n or a click opens it', async ({ page, isMobile }) => {
  test.skip(isMobile, 'a phone folds it by the same rule; the key is desktop')
  await page.goto(`/?token=${token}`)
  const open = page.locator('.new-session-open')
  await expect(open).toBeVisible()
  await expect(open).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('button', { name: 'New session', exact: true })).toBeHidden()
  await page.locator('body').press('n')
  await expect(page.getByLabel('Working directory')).toBeFocused()
  await expect(page.getByRole('button', { name: 'New session', exact: true })).toBeVisible()
})

test('amber stays on the REQUIRES block and the counts; waiting and Allow are ink', async ({ page }) => {
  await newSession(page)
  await say(page, 'please permission')
  const card = page.locator('.request.permission')
  await expect(card).toBeVisible()
  const color = (l: Locator, prop: 'color' | 'backgroundColor') => l.evaluate((el, p) => getComputedStyle(el)[p], prop)
  const ink = await page.evaluate(() => getComputedStyle(document.body).color)
  await expect(page.locator('.chat-header .status-waiting')).toBeVisible()
  expect(await color(page.locator('.chat-header .status-waiting'), 'color')).toBe(ink)
  expect(await color(card.getByRole('button', { name: /^Allow/ }).first(), 'backgroundColor')).toBe(ink)
  const tail = page.locator('.working-tail.waiting')
  if (await tail.count()) expect(await color(tail, 'color')).not.toBe(await color(card.locator('.request-kw'), 'color'))
})

// The wide screen's margin: the turns as a table of contents to the right of
// the text column, never over it; a narrower screen has no room and no list.
test('a wide transcript hangs its turns in the right margin', async ({ page, isMobile }) => {
  test.skip(isMobile, 'a phone has no margin')
  await page.setViewportSize({ width: 1680, height: 900 })
  await newSession(page)
  await say(page, 'first question')
  await expect(page.locator('.item.assistant', { hasText: 'echo: first question' })).toBeVisible()
  await say(page, 'second question')
  await expect(page.locator('.item.assistant', { hasText: 'echo: second question' })).toBeVisible()
  const nav = page.getByRole('navigation', { name: 'Turns' })
  await expect(nav.getByRole('button')).toHaveCount(2)
  const list = await box(nav.locator('ol'))
  const column = await box(page.locator('.items'))
  expect(list.left).toBeGreaterThanOrEqual(column.right)
  await expect(nav.getByRole('button', { name: /second question/ })).toHaveAttribute('aria-current', 'location')
  await nav.getByRole('button', { name: /first question/ }).click()
  await expect(nav.getByRole('button', { name: /first question/ })).toHaveAttribute('aria-current', 'location')
  // the bar says how the fleet stands, beside Overview's word
  await expect(page.getByRole('button', { name: 'Overview', exact: true })).toBeVisible()
  await page.setViewportSize({ width: 1100, height: 900 })
  await expect(nav).toBeHidden()
})

test('Overview reads the fleet while a session waits', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the phone has no room for the line')
  await page.setViewportSize({ width: 1440, height: 900 })
  await newSession(page)
  await say(page, 'please permission')
  await expect(page.locator('.request.permission')).toBeVisible()
  const overview = page.getByRole('button', { name: 'Overview', exact: true })
  await expect(overview).toHaveAccessibleDescription(/\d+ waiting/)
  await expect(overview.locator('.fleet')).toBeVisible()
})
