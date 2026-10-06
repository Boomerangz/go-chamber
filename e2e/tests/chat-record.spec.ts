import { expect, test } from '@playwright/test'
import { token } from '../playwright.config'
import { openNewSession, showPane } from './pane'

// What the transcript keeps of requests and crashes, and the one text column
// everything in a session shares.

async function newSession(page: import('@playwright/test').Page) {
  await page.goto(`/?token=${token}`)
  await showPane(page, 'Sessions')
  await openNewSession(page)
  await page.getByRole('radio', { name: 'Claude' }).click()
  await page.getByLabel('Working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByLabel('message')).toBeVisible()
}

async function send(page: import('@playwright/test').Page, text: string) {
  await page.getByLabel('message').fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
}

test('a denied command reads "not run", a skipped question "skipped", without raw tool lines', async ({ page }) => {
  await newSession(page)
  await send(page, 'please permission')
  await expect(page.locator('.request-title', { hasText: 'Run command' })).toBeVisible()
  await page.getByRole('button', { name: 'Deny', exact: true }).click()
  await page.getByLabel('deny reason').fill('not now')
  await page.getByRole('button', { name: 'Confirm deny' }).click()
  await expect(page.locator('.item.assistant', { hasText: 'denied: not now' })).toBeVisible()
  const command = page.locator('.item.command')
  await expect(command.locator('.exit-tag')).toHaveText('not run')
  await expect(command).not.toHaveClass(/state-failed/)
  await expect(page.locator('.exit-bad')).toHaveCount(0)

  await send(page, 'please ask me')
  await expect(page.locator('.request.question')).toBeVisible()
  await page.getByRole('button', { name: 'Skip' }).click()
  await expect(page.locator('.item.decision .decision-kw', { hasText: 'skipped' })).toBeVisible()
  await expect(page.locator('.decision-denied')).toHaveCount(1)
  // The decision record tells the question; the raw tool line would repeat it.
  await expect(page.getByText('AskUserQuestion')).toHaveCount(0)
})

test('a crash keeps what the agent already wrote', async ({ page }, info) => {
  await newSession(page)
  const text = `crash now please ${info.project.name}`
  await send(page, text)
  await expect(page.getByText('Turn interrupted')).toBeVisible()
  await expect(page.locator('.item.assistant', { hasText: `echo: ${text}` })).toBeVisible()
  await page.reload()
  await expect(page.locator('.item.assistant', { hasText: `echo: ${text}` })).toBeVisible()
})

test('transcript, working tail, request card and composer share one column', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', 'one column edge to edge on a phone')
  await newSession(page)
  await send(page, 'please permission')
  await expect(page.locator('.request.permission')).toBeVisible()
  const left = async (selector: string) => (await page.locator(selector).first().boundingBox())!.x
  const text = await left('.items > .row')
  // The column with its turn margin: the composer and the request slot.
  const column = await left('.composer')
  expect(Math.abs((await left('.items')) - column)).toBeLessThan(1)
  // The card springs in from the margin; measure it once it has settled.
  await expect.poll(async () => Math.abs((await left('.request-slot')) - column)).toBeLessThan(1)
  // The words start at the same edge: transcript, tail (mono) and card.
  const tail = await page.locator('.working-tail').evaluate((el) => el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft))
  expect(Math.abs(tail - text)).toBeLessThan(1)
  expect(Math.abs((await left('.request')) - text)).toBeLessThan(1)
})
