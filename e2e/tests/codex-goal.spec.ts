import { expect, test } from '@playwright/test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { token } from '../playwright.config'
const headers = { Authorization: `Bearer ${token}` }

test('a Codex goal runs on its own turns and shows its state', async ({ page }) => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), 'codex-goal-')))
  try {
    const response = await page.request.post('/api/sessions', { headers, data: { agent: 'codex', cwd } })
    expect(response.ok()).toBe(true)
    const session = await response.json()
    await page.goto(`/s/${session.id}?token=${token}`)
    const send = async (text: string) => { await page.getByLabel('Message').fill(text); await page.getByRole('button', { name: 'Send', exact: true }).click() }
    await send('/goal ship the probe')
    await expect(page.getByText('goal: working on ship the probe', { exact: true })).toBeVisible()
    await expect(page.getByText('goal: done', { exact: true })).toBeVisible()
    const chip = page.locator('.chat-meta').getByText('goal complete', { exact: true })
    await expect(chip).toHaveAttribute('title', 'ship the probe')
    await expect(page.locator('.chat-meta .status')).toHaveText('idle')
    await send('/goal')
    await expect(page.getByText(/Goal complete · 42 tokens/)).toBeVisible()
    await expect(page.locator('.chat-meta .status')).toHaveText('idle')
    await send('/goal clear')
    await expect(page.getByText('Goal cleared.', { exact: true })).toBeVisible()
    await expect(chip).toHaveCount(0)
    await send('after the goal')
    await expect(page.getByText('echo: after the goal', { exact: true })).toBeVisible()
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
