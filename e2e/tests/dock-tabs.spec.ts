import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import { token } from '../playwright.config'

const headers = { Authorization: `Bearer ${token}` }

// The dock's tab strip never cuts a tab off mid-word at its edge: tabs
// not selected give up their titles (an ellipsis says so) before the strip
// scrolls, the selected one is whole, and a tab hidden past an edge fades.
test('the dock fits its terminal tabs before it clips one', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the dock is desktop-only')
  await page.addInitScript(() => Object.defineProperty(window, 'RTCPeerConnection', { value: undefined }))
  const root = fs.realpathSync(fs.mkdtempSync(`${os.tmpdir()}/gc-tabs-`))
  const cwd = `${root}/fix-the-very-long-branch-name-for-header-fold-test`
  fs.mkdirSync(cwd)
  const r = await page.request.post('/api/sessions', { headers, data: { agent: 'claude', cwd } })
  const { id } = (await r.json()) as { id: string }
  await page.setViewportSize({ width: 1100, height: 800 })
  await page.goto(`/s/${id}?token=${token}`)
  await page.getByRole('toolbar', { name: 'Dock' }).getByRole('button', { name: /^Terminal/ }).click()
  const panel = page.getByRole('region', { name: 'Terminals' })
  const add = panel.getByRole('button', { name: 'New terminal in session folder' })
  await add.click()
  await expect(panel.getByRole('tab')).toHaveCount(1)
  await add.click()
  await expect(panel.getByRole('tab')).toHaveCount(2)
  await expect(panel.getByRole('tab', { selected: true })).toHaveAccessibleName(/test 2$/)
  // hovered, the selected tab shows its rename pencil too
  await panel.getByRole('tab', { selected: true }).hover()

  const clipped = (fits: boolean) =>
    panel.locator('.terminal-tabs').evaluate((strip, fits) => {
      const box = strip.getBoundingClientRect()
      const fade = strip.dataset.fade ?? ''
      const out: string[] = []
      for (const li of strip.querySelectorAll('li')) {
        const r = li.getBoundingClientRect()
        const name = li.querySelector('[role="tab"]')?.textContent ?? ''
        if (r.left < box.left - 1 && !/start|both/.test(fade)) out.push(`${name} cut at the start, no fade`)
        if (r.right > box.right + 1 && !/end|both/.test(fade)) out.push(`${name} cut at the end, no fade`)
        // two tabs fit a 1100px dock: neither is cut at all
        if (fits && (r.left < box.left - 1 || r.right > box.right + 1)) out.push(`${name} cut by the strip`)
        // a tab in view keeps its close button clear of its title
        const close = li.querySelector<HTMLElement>('.close-terminal')
        if (close && r.left >= box.left && r.right <= box.right) {
          const c = close.getBoundingClientRect()
          const hit = document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2)
          if (!close.contains(hit)) out.push(`${name} close button covered`)
        }
      }
      const selected = strip.querySelector('li:has([aria-selected="true"])')!.getBoundingClientRect()
      if (selected.left < box.left - 1 || selected.right > box.right + 1) out.push('selected tab not whole')
      return out
    }, fits)
  await expect.poll(() => clipped(true)).toEqual([])
  // Back to the first: it is whole now, and the second still fits.
  await panel.getByRole('tab').first().click()
  await expect.poll(() => clipped(true)).toEqual([])
  // More than fit: the strip scrolls, and an edge with tabs past it fades.
  for (let n = 3; n <= 6; n++) {
    await add.click()
    await expect(panel.getByRole('tab')).toHaveCount(n)
  }
  await expect.poll(() => clipped(false)).toEqual([])
  await expect(panel.locator('.terminal-tabs')).toHaveAttribute('data-fade', /start|both/)

  const shells = (await (await page.request.get('/api/terminals', { headers })).json()) as { id: string; cwd: string }[]
  for (const t of shells.filter((t) => t.cwd.startsWith(root))) await page.request.delete(`/api/terminals/${t.id}`, { headers })
})
