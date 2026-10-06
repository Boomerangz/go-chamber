import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import { token } from '../playwright.config'

// The dock belongs to the open session: its terminal tab offers the
// session's own folder, and a tray with nothing in it doesn't reopen.

const headers = { Authorization: `Bearer ${token}` }

test('the Terminal dock doesn’t carry one project’s shell into another session', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the dock is desktop-only')
  await page.addInitScript(() => Object.defineProperty(window, 'RTCPeerConnection', { value: undefined }))
  const root = fs.realpathSync(fs.mkdtempSync(`${os.tmpdir()}/gc-scope-`))
  const ids: string[] = []
  for (const name of ['first-proj', 'second-proj']) {
    fs.mkdirSync(`${root}/${name}`)
    const r = await page.request.post('/api/sessions', { headers, data: { agent: 'claude', cwd: `${root}/${name}` } })
    ids.push(((await r.json()) as { id: string }).id)
  }
  await page.goto(`/s/${ids[0]}?token=${token}`)
  await page.getByRole('toolbar', { name: 'Dock' }).getByRole('button', { name: /^Terminal/ }).click()
  const panel = page.getByRole('region', { name: 'Terminals' })
  await panel.getByRole('button', { name: 'New terminal in session dir' }).click()
  await expect(panel.getByTestId('terminal-view')).toBeVisible()

  await page.goto(`/s/${ids[1]}`)
  await expect(panel.getByTestId('terminal-view')).toHaveCount(0)
  await expect(panel).toContainText('No shell in second-proj.')
  await panel.getByRole('button', { name: 'Open shell in second-proj' }).click()
  await expect(panel.getByTestId('terminal-view')).toBeVisible()
  await expect(panel.getByRole('tab', { selected: true })).toHaveAccessibleName(/second-proj/)
  const shells = (await (await page.request.get('/api/terminals', { headers })).json()) as { id: string; cwd: string }[]
  for (const t of shells.filter((t) => t.cwd.startsWith(root))) await page.request.delete(`/api/terminals/${t.id}`, { headers })
})

test('a Requests dock left open reopens on its rail when nothing waits', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the dock is desktop-only')
  await page.addInitScript(() => localStorage.setItem('gc.layout', JSON.stringify({ dock: 'requests' })))
  const pending = await (await page.request.get('/api/requests', { headers })).json()
  test.skip(Array.isArray(pending) && pending.length > 0, 'another scenario left a request waiting')
  await page.goto(`/?token=${token}`)
  await expect(page.getByRole('toolbar', { name: 'Dock' })).toBeVisible()
  await expect(page.locator('.layout')).toHaveAttribute('data-dock', 'closed')
})
