import { expect, test, type Page } from '@playwright/test'
import { token } from '../playwright.config'
import { openNewSession } from './pane'

async function newSession(page: Page, agent: 'Claude' | 'Codex') {
  await page.goto(`/?token=${token}`)
  await openNewSession(page)
  await page.getByRole('radio', { name: agent }).click()
  await page.getByLabel('Working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByLabel('Message')).toBeVisible()
}

// oneRow says the header's title row is one row: every shown part of it
// (not the opened settings) sits beside the title, nothing spills sideways.
async function expectOneRow(page: Page, what: string) {
  const header = page.locator('.chat-header')
  // A resize settles once the header measured itself again.
  await expect.poll(() => header.evaluate((el) => {
    const heading = el.querySelector('.chat-heading')!.getBoundingClientRect()
    const parts = [...el.querySelectorAll<HTMLElement>(':scope > .avatar, :scope > .chat-more, .chat-meta > .status, .chat-meta > .usage, .chat-meta > .no-approvals, .chat-meta > .archived-tag')]
    const out = parts
      .filter((p) => p.getBoundingClientRect().width > 0)
      .filter((p) => { const r = p.getBoundingClientRect(); return r.top >= heading.bottom || r.bottom <= heading.top || r.right > el.getBoundingClientRect().right + 1 })
      .map((p) => p.className)
    if (el.scrollWidth > el.clientWidth + 1) out.push('header overflows')
    return out
  }), { message: what }).toEqual([])
}

const LONG = 'Refactor the session header so it never wraps into a second row with docks'

// With any dock beside the chat, at any desktop width, for either agent and
// a long title, the header stays one row, folded or not, details open or not.
for (const agent of ['Claude', 'Codex'] as const) {
  test(`${agent}'s header stays one row with every dock`, async ({ page, isMobile }) => {
    test.skip(isMobile, 'a phone folds by its own rules')
    test.setTimeout(90_000)
    await page.setViewportSize({ width: 1440, height: 900 })
    await newSession(page, agent)
    await page.getByLabel('Message').fill(LONG)
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(page.locator('.item.assistant', { hasText: `echo: ${LONG}` })).toBeVisible()
    const dock = page.getByRole('toolbar', { name: 'Dock' })
    for (const width of [900, 1280, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      for (const name of ['none', 'Terminal', 'Changes', 'Requests']) {
        const button = name === 'none' ? null : dock.getByRole('button', { name: new RegExp(`^${name}`) })
        if (button) await button.click()
        const what = `${agent} ${width} ${name}`
        await expectOneRow(page, what)
        const more = page.getByRole('button', { name: 'Session details' })
        if (await more.isVisible()) {
          await more.click()
          await expectOneRow(page, `${what}, details open`)
          if (await more.isVisible()) await more.click()
        }
        if (button && (await button.getAttribute('aria-pressed')) === 'true') await button.click()
      }
    }
  })
}

// At 1440 with no dock a long title is cut rather than fold Codex's settings.
test('a long Codex title leaves its settings inline at 1440px', async ({ page, isMobile }) => {
  test.skip(isMobile, 'a phone folds by its own rules')
  await page.setViewportSize({ width: 1440, height: 900 })
  await newSession(page, 'Codex')
  await page.getByLabel('Message').fill(LONG)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.item.assistant', { hasText: `echo: ${LONG}` })).toBeVisible()
  await expect(page.locator('.chat-header h2')).toContainText('Refactor')
  await expect(page.locator('.chat-header')).not.toHaveAttribute('data-fold')
  await expect(page.getByLabel('Approval reviewer')).toBeVisible()
  await expectOneRow(page, 'codex 1440 long title')
})

// At 1440 with no dock open both agents show their settings inline: Codex's
// mode and approvals are no longer folded behind "⋯" while Claude's show.
for (const agent of ['Claude', 'Codex'] as const) {
  test(`${agent} shows its settings inline at 1440px`, async ({ page, isMobile }) => {
    test.skip(isMobile, 'a phone folds by its own rules')
    await page.setViewportSize({ width: 1440, height: 900 })
    await newSession(page, agent)
    await page.getByLabel('Message').fill('hello header')
    await page.getByRole('button', { name: 'Send' }).click()
    await expect(page.locator('.item.assistant', { hasText: 'echo: hello header' })).toBeVisible()
    const header = page.locator('.chat-header')
    await expect(header).not.toHaveAttribute('data-fold')
    await expect(page.getByRole('button', { name: 'Session details' })).toBeHidden()
    await expect(page.getByLabel('Permission mode')).toBeVisible()
    if (agent === 'Codex') await expect(page.getByLabel('Approval reviewer')).toBeVisible()
    expect(await header.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  })
}
