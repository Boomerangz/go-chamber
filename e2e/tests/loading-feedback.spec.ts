import { expect, test } from '@playwright/test'
import { token } from '../playwright.config'
import { showPane } from './pane'

test('shows startup feedback before JavaScript arrives', async ({ page }) => {
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  await page.route('**/assets/index-*.js', async (route) => {
    await gate
    await route.continue()
  })
  await page.goto(`/?token=${token}`, { waitUntil: 'commit' })
  try {
    await expect(page.getByRole('status', { name: 'Starting go-chamber' })).toBeVisible()
  } finally { release() }
  await expect(page.locator('.topbar')).toBeVisible()
  await expect(page.getByRole('status', { name: 'Starting go-chamber' })).toHaveCount(0)
})

test('loading sessions has visible placeholders, then a direct route to starting', async ({ page }, info) => {
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  await page.route('**/api/sessions', async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    await gate
    await route.fulfill({ json: [] })
  })
  // The server is shared with other workers: their sessions would reach
  // the list over the socket while the listing is held, and take the
  // placeholders' place. The socket opens and stays quiet.
  await page.routeWebSocket('**/api/ws', () => {})
  await page.goto(`/?token=${token}`)
  await showPane(page, 'Chat')
  const skeleton = page.locator('.empty .skeleton-line').first()
  try {
    await expect(skeleton).toBeVisible()
    expect((await skeleton.boundingBox())!.height).toBeGreaterThanOrEqual(8)
    await page.screenshot({ path: info.outputPath('loading.png') })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await skeleton.evaluate((el) => getComputedStyle(el.closest('.skeleton')!).animationDuration)).toBe('0s')
  } finally { release() }
  await expect(skeleton).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('ready.png') })
  await page.getByRole('button', { name: 'Choose a project' }).click()
  await expect(page.getByRole('textbox', { name: 'Working directory' })).toBeFocused()
  await expect(page.getByRole('button', { name: 'New session', exact: true })).toBeVisible()
})

test('pending icon buttons keep their size and show one readable spinner', async ({ page }) => {
  await page.goto(`/?token=${token}`)
  await page.locator('.topbar').waitFor()
  await page.evaluate(() => {
    const b = document.createElement('button')
    b.id = 'busy-probe'
    b.className = 'btn btn-icon'
    b.setAttribute('aria-label', 'Probe')
    b.innerHTML = '<svg width="14" height="14"></svg>'
    document.body.append(b)
  })
  const button = page.locator('#busy-probe')
  const before = await button.boundingBox()
  await button.evaluate((el) => el.setAttribute('aria-busy', 'true'))
  expect((await button.boundingBox())!.width).toBe(before!.width)
  const state = await button.evaluate((el) => {
    const spinner = getComputedStyle(el, '::before')
    return { round: spinner.borderRadius, animation: spinner.animationName, icon: getComputedStyle(el.querySelector('svg')!).visibility }
  })
  expect(state).toEqual({ round: '50%', animation: 'busy-spin', icon: 'hidden' })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  expect(await button.evaluate((el) => getComputedStyle(el, '::before').animationDuration)).toBe('0s')
})
