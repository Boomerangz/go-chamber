import { expect, test } from '@playwright/test'
import { token } from '../playwright.config'
import { showShells } from './pane'

test('names a session and a terminal', async ({ page }, info) => {
  const name = `Release notes ${info.project.name}`
  await page.goto(`/?token=${token}`)
  await page.getByLabel('working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await page.getByRole('button', { name: 'Rename session' }).click()
  await page.getByRole('textbox', { name: 'session name' }).fill(name)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name })).toBeVisible()

  // The first message no longer overrides a chosen name, and it survives a reload.
  await page.getByLabel('message').fill('hello')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText('echo: hello')).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name })).toBeVisible()

  await page.getByRole('radio', { name: /^Terminal/ }).click()
  const panel = page.getByRole('region', { name: 'Terminals' })
  await panel.getByLabel('terminal directory').fill('/tmp')
  await panel.getByRole('button', { name: 'New terminal' }).click()
  await page.getByRole('button', { name: 'Rename terminal' }).click()
  await page.getByRole('textbox', { name: 'terminal name' }).fill(`logs ${info.project.name}`)
  await page.keyboard.press('Enter')
  await showShells(page)
  await expect(panel.getByRole('tab', { selected: true })).toContainText(`logs ${info.project.name}`)
})
