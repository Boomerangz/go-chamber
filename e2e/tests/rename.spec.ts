import { expect, test } from '@playwright/test'
import { token } from '../playwright.config'
import { openNewSession, showShells } from './pane'

test('names a session and a terminal', async ({ page }, info) => {
  const name = `Release notes ${info.project.name}`
  await page.goto(`/?token=${token}`)
  await openNewSession(page)
  await page.getByLabel('Working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await page.getByRole('button', { name: 'Rename session' }).click()
  await page.getByRole('textbox', { name: 'Session name' }).fill(name)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name })).toBeVisible()

  // The first message no longer overrides a chosen name, and it survives a reload.
  await page.getByLabel('Message').fill('hello')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText('echo: hello')).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name })).toBeVisible()

  await page.getByRole('radio', { name: /^Terminal/ }).click()
  const panel = page.getByRole('region', { name: 'Terminals' })
  await panel.getByLabel('Terminal directory').fill('/tmp')
  await panel.getByRole('button', { name: 'New terminal' }).click()
  await page.getByRole('button', { name: 'Rename terminal' }).click()
  await page.getByRole('textbox', { name: 'Terminal name' }).fill(`logs ${info.project.name}`)
  await page.keyboard.press('Enter')
  await showShells(page)
  await expect(panel.getByRole('tab', { selected: true })).toContainText(`logs ${info.project.name}`)
})
