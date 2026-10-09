import { expect, test, type Page } from '@playwright/test'
import { token } from '../playwright.config'
import { openNewSession } from './pane'

// A phone keeps its height for the transcript: the composer stays one row of
// icons, a request card isn't announced twice, and a working connection
// draws nothing. The question card's Skip never outweighs its Submit.

const message = (page: Page) => page.getByLabel('Message', { exact: true })

async function newSession(page: Page) {
  await page.goto(`/?token=${token}`)
  await openNewSession(page)
  await page.getByLabel('Working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(message(page)).toBeVisible()
}

async function say(page: Page, text: string) {
  await message(page).fill(text)
  await page.getByRole('button', { name: /^(Send|Steer)$/ }).click()
}

test('a phone composer is one row: the text beside Attach and Send as icons', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'the phone layout')
  await newSession(page)
  const send = page.getByRole('button', { name: 'Send' })
  const attach = page.getByRole('button', { name: 'Attach', exact: true })
  for (const b of [send, attach]) {
    await expect(b.locator('svg')).toBeVisible()
    const label = await b.locator('.btn-label').boundingBox()
    expect(label!.width * label!.height).toBeLessThanOrEqual(1)
  }
  const field = await message(page).boundingBox()
  const button = await send.boundingBox()
  expect(button!.x).toBeGreaterThan(field!.x + field!.width - 1)
  expect(Math.abs(button!.y + button!.height - (field!.y + field!.height))).toBeLessThan(12)
})

test('a phone shows an open request once: no "waiting for you" line above its card', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'the phone layout')
  await newSession(page)
  await say(page, 'please permission')
  await expect(page.locator('.request.permission')).toBeVisible()
  await expect(page.locator('.working-tail')).toBeHidden()
  await expect(page.locator('.chat-header .status-waiting')).toBeVisible()
})

test("a phone's top bar draws nothing for a working connection", async ({ page, isMobile }) => {
  test.skip(!isMobile, 'the phone layout')
  await page.goto(`/?token=${token}`)
  const health = page.getByRole('status', { name: 'online' })
  await expect(health).toBeAttached()
  const b = await health.boundingBox()
  expect(b!.width * b!.height).toBeLessThanOrEqual(1)
})

test("a question's Skip is quieter than its Submit", async ({ page }) => {
  await newSession(page)
  await say(page, 'ask me something')
  const card = page.locator('.request.question')
  await expect(card).toBeVisible()
  const border = await card.getByRole('button', { name: 'Skip' }).evaluate((el) => getComputedStyle(el).borderTopColor)
  expect(border).toBe('rgba(0, 0, 0, 0)')
})

test("a phone's top bar steps aside while the owner types in the chat", async ({ page, isMobile }) => {
  test.skip(!isMobile, 'the on-screen keyboard is a phone matter')
  await newSession(page)
  const modes = page.getByRole('radiogroup', { name: 'Mode' })
  await expect(modes).toBeVisible()
  await message(page).focus()
  await expect(page.locator('html')).toHaveAttribute('data-typing', 'chat')
  await expect(modes).toBeHidden()
  await message(page).blur()
  await expect(modes).toBeVisible()
})

test('a phone hides Attach while a turn runs: images wait for the next message', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'the phone composer')
  await newSession(page)
  const attach = page.getByRole('button', { name: 'Attach', exact: true })
  await expect(attach).toBeVisible()
  await say(page, 'please permission')
  await expect(page.locator('.request.permission')).toBeVisible()
  await expect(attach).toBeHidden()
})

test('a phone folds the accounts to one line under the sessions', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'the phone sidebar')
  await page.goto(`/?token=${token}`)
  const fold = page.getByRole('button', { name: 'Accounts' })
  await expect(fold).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('.accounts .account').first()).toBeHidden()
  await fold.click()
  await expect(page.locator('.accounts .account').first()).toBeVisible()
})

test('a phone picks the agent from one row', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'the phone sidebar')
  await page.goto(`/?token=${token}`)
  await openNewSession(page)
  const tops = await page.getByRole('radiogroup', { name: 'Agent' }).getByRole('radio').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)))
  expect(tops.length).toBeGreaterThan(2)
  expect(new Set(tops).size).toBe(1)
})

test('the first-message hint keeps a long folder to one line', async ({ page }) => {
  await newSession(page)
  const where = page.locator('.chat-hint-where .path-text')
  await expect(where).toBeVisible()
  expect(await where.evaluate((el) => el.getClientRects().length)).toBe(1)
})

test('a phone writes the hint without keyboard keys', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'no keyboard on a phone')
  await newSession(page)
  await expect(page.locator('.chat-hint-keys')).toContainText('@ file')
  await expect(page.locator('.chat-hint-keys kbd')).toHaveCount(0)
})

test("a phone's search field and a question's Other field are a finger's size and don't zoom", async ({ page, isMobile }) => {
  test.skip(!isMobile, 'the phone layout')
  await newSession(page)
  await say(page, 'ask me something')
  const other = page.locator('.request.question').getByPlaceholder('Other…').first()
  await expect(other).toBeVisible()
  expect(parseFloat(await other.evaluate((el) => getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16)
  await page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: /^Sessions/ }).click()
  const search = page.getByRole('searchbox', { name: /search sessions/i })
  await expect(search).toBeVisible()
  expect((await search.boundingBox())!.height).toBeGreaterThanOrEqual(40)
})
