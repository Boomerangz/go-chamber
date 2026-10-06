import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import { token } from '../playwright.config'
import { openNewSession } from './pane'

// Between the phone and a wide screen the chat keeps its room: an open dock
// and a dragged sessions list give way to it, never the other way round.

const CHAT_MIN = 360

async function startSession(page: Page) {
  const dir = fs.realpathSync(fs.mkdtempSync(`${os.tmpdir()}/gc-room-`))
  await page.goto(`/?token=${token}`)
  await openNewSession(page)
  await page.getByLabel('Working directory').fill(dir)
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByLabel('Message')).toBeVisible()
}

// usable says the chat is at least CHAT_MIN wide and Send is the element
// a click at its middle lands on.
async function expectUsableChat(page: Page) {
  const chat = (await page.locator('.layout > .chat').boundingBox())!
  expect(chat.width).toBeGreaterThanOrEqual(CHAT_MIN - 1)
  const send = page.getByRole('button', { name: 'Send' })
  const hit = await send.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    return at !== null && el.contains(at)
  })
  expect(hit).toBe(true)
}

const docks = ['Requests', 'Terminal', 'Changes'] as const

test.describe('a 900px window', () => {
  test.use({ viewport: { width: 900, height: 800 } })
  for (const name of docks) {
    test(`the ${name} dock leaves the chat its room`, async ({ page, isMobile }) => {
      test.skip(isMobile, 'the dock is desktop-only')
      await page.addInitScript(() => Object.defineProperty(window, 'RTCPeerConnection', { value: undefined }))
      await startSession(page)
      await page.getByRole('toolbar', { name: 'Dock' }).getByRole('button', { name: new RegExp(`^${name}`) }).click()
      await expect(page.locator('.dock-body')).toBeVisible()
      await expectUsableChat(page)
      // the dock took the sessions list's place; showing it again collapses the dock
      await expect(page.locator('.layout')).toHaveAttribute('data-sidebar', 'off')
      await page.getByRole('button', { name: 'Show sessions' }).first().click()
      await expect(page.locator('.dock-body')).toHaveCount(0)
      await expect(page.locator('.layout > .sidebar')).toBeVisible()
      await expectUsableChat(page)
    })
  }

  test('dragging the sessions list wide can’t squeeze the chat', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the splitter is desktop-only')
    await startSession(page)
    const handle = page.getByRole('separator', { name: 'Resize the sessions list' })
    const b = (await handle.boundingBox())!
    await page.mouse.move(b.x + b.width / 2, b.y + 200)
    await page.mouse.down()
    await page.mouse.move(b.x + 600, b.y + 200, { steps: 4 })
    await page.mouse.up()
    await expectUsableChat(page)
  })
})

test.describe('a 1100px window', () => {
  test.use({ viewport: { width: 1100, height: 800 } })
  test('with a dock open, a wide sessions list still leaves the chat its room', async ({ page, isMobile }) => {
    test.skip(isMobile, 'the dock is desktop-only')
    await startSession(page)
    await page.getByRole('toolbar', { name: 'Dock' }).getByRole('button', { name: 'Changes' }).click()
    await expect(page.locator('.dock-body')).toBeVisible()
    await expect(page.locator('.layout')).not.toHaveAttribute('data-sidebar', 'off')
    const handle = page.getByRole('separator', { name: 'Resize the sessions list' })
    const b = (await handle.boundingBox())!
    await page.mouse.move(b.x + b.width / 2, b.y + 200)
    await page.mouse.down()
    await page.mouse.move(b.x + 600, b.y + 200, { steps: 4 })
    await page.mouse.up()
    await expectUsableChat(page)
  })
})
