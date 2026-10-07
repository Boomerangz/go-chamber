import { expect, test, type Page } from '@playwright/test'
import { token } from '../playwright.config'
import { openNewSession, showPane } from './pane'

async function newSession(page: Page) {
  await showPane(page, 'Sessions')
  await openNewSession(page)
  await page.getByLabel('Working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByLabel('Message')).toBeVisible()
}

async function say(page: Page, text: string, reply = `echo: ${text.split('\n')[0]}`) {
  await page.getByLabel('Message').fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.item.assistant', { hasText: reply })).toBeVisible()
}

async function open(page: Page, title: string) {
  await showPane(page, 'Sessions')
  // Other specs leave many sessions; the search finds this one among them.
  const search = page.getByRole('searchbox', { name: 'Search sessions' })
  await search.fill(title)
  await page.locator('button.session', { hasText: title }).first().click()
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible()
  await showPane(page, 'Sessions')
  await search.fill('')
  await showPane(page, 'Chat')
}

const tall = (n: number) => [`turn ${n}`, ...Array.from({ length: 12 }, (_, i) => `line ${i} of turn ${n}`)].join('\n')

test('a session keeps its reading place when the owner switches away and back', async ({ page }, info) => {
  const name = `reading place ${info.project.name} ${Date.now().toString(36)}`
  await page.goto(`/?token=${token}`)
  await newSession(page)
  await say(page, name)
  for (let n = 1; n <= 6; n++) await say(page, tall(n))
  const scroll = page.locator('.chat .scroll')
  // Opened and followed to the end; now read from the top.
  const at = await scroll.evaluate((el) => {
    el.scrollTop = Math.round(el.scrollHeight / 3)
    return el.scrollTop
  })
  await expect(page.locator('.jump-latest')).toHaveCount(1)
  // A second session, then back to the first.
  await newSession(page)
  const other = `elsewhere ${name.slice("reading place ".length)}`
  await say(page, other)
  await open(page, name)
  await expect(page.locator('.jump-latest')).toHaveCount(1)
  expect(Math.abs((await scroll.evaluate((el) => el.scrollTop)) - at)).toBeLessThan(4)

  // Read to the end: back from elsewhere, it opens at the end again.
  await scroll.evaluate((el) => { el.scrollTop = el.scrollHeight })
  await expect(page.locator('.jump-latest')).toHaveCount(0)
  await open(page, other)
  await open(page, name)
  await expect(page.locator('.item.assistant', { hasText: 'echo: turn 6' })).toBeInViewport()
  expect(await scroll.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(48)
})
