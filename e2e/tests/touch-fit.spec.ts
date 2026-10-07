import { expect, test, type Page } from '@playwright/test'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { token } from '../playwright.config'

// Phones held sideways and touch tablets: the wide layout with a finger's
// targets, a short window and the notch at a side.

const headers = { Authorization: `Bearer ${token}` }

async function sessionIn(page: Page, prefix: string) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
  const created = await page.request.post('/api/sessions', { headers, data: { agent: 'claude', cwd: dir } })
  const { id } = (await created.json()) as { id: string }
  return { dir, id }
}

test.describe('a phone held sideways', () => {
  test.use({ hasTouch: true, isMobile: true })
  for (const [width, height] of [[844, 390], [932, 430]]) {
    test(`the sessions stay reachable at ${width}x${height}`, async ({ page }, info) => {
      test.skip(info.project.name === 'mobile', 'the viewport is set here')
      await page.setViewportSize({ width, height })
      const { dir, id } = await sessionIn(page, 'gc-land-')
      await page.goto(`/?token=${token}`)
      // the search and the list are not squeezed away by the form and the footer
      const search = page.locator('.sidebar .session-search')
      await expect(search).toBeVisible()
      expect((await search.boundingBox())!.height).toBeGreaterThanOrEqual(30)
      const row = page.getByRole('region', { name: `Project ${path.basename(dir)}` }).locator('.session').first()
      await row.scrollIntoViewIfNeeded()
      await expect(row).toBeInViewport({ ratio: 0.9 })
      // nothing (the footer) sits over the row: the tap reaches it
      await row.tap()
      await expect(page).toHaveURL(new RegExp(`/s/${id}`))
    })
  }

  // edges lists the watched parts that reach into the notch or the home
  // indicator's strip.
  function edges(page: Page, inset: { left: number; right: number; bottom: number }) {
    return page.evaluate((inset) => {
      const out: string[] = []
      const W = window.innerWidth
      const H = window.innerHeight
      const watch = ['.brand h1', '.topbar-end', '.sidebar .segmented', '.sidebar .folder-field', '.dock-rail', '.composer', '.term-sidebar .folder-field', '.term-main']
      for (const s of watch) {
        const e = document.querySelector(s)
        if (!e) continue
        const r = e.getBoundingClientRect()
        if (r.width === 0) continue
        if (r.left < inset.left - 0.5) out.push(`${s} left ${Math.round(r.left)}`)
        if (r.right > W - inset.right + 0.5) out.push(`${s} right ${Math.round(r.right)}`)
        if (r.bottom > H - inset.bottom + 0.5) out.push(`${s} bottom ${Math.round(r.bottom)}`)
      }
      return out
    }, inset)
  }

  test('nothing sits under the notch or the home indicator', async ({ page }, info) => {
    test.skip(info.project.name === 'mobile', 'the viewport is set here')
    await page.setViewportSize({ width: 844, height: 390 })
    const inset = { top: 0, left: 47, right: 47, bottom: 21 }
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: inset })
    const { id } = await sessionIn(page, 'gc-notch-')
    await page.goto(`/?token=${token}`)
    await page.goto(`/s/${id}`)
    await expect(page.getByLabel('Message')).toBeVisible()
    await expect.poll(() => edges(page, inset)).toEqual([])
    await page.getByRole('radiogroup', { name: /mode/i }).getByRole('radio', { name: /^Terminal/ }).tap()
    await expect(page.locator('.term-sidebar')).toBeVisible()
    await expect.poll(() => edges(page, inset)).toEqual([])
  })
})
