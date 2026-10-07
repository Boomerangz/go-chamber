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
})
