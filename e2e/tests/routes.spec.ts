import { expect, test } from '@playwright/test'
import { token } from '../playwright.config'
import { openNewSession } from './pane'

test('a reload keeps the open session and terminal, Back returns', async ({ page }, info) => {
  const text = `route ${info.project.name}`
  await page.goto(`/?token=${token}`)
  await openNewSession(page)
  await page.getByLabel('Working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await page.getByLabel('Message').fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText(`echo: ${text}`)).toBeVisible()
  await expect(page).toHaveURL(/\/s\/[^/]+$/)
  const sessionURL = page.url()

  await page.reload()
  await expect(page.getByText(`echo: ${text}`)).toBeVisible()
  await expect(page).toHaveURL(sessionURL)

  await page.getByRole('radio', { name: /^Terminal/ }).click()
  const panel = page.getByRole('region', { name: 'Terminals' })
  await panel.getByLabel('Terminal directory').fill('/tmp')
  await panel.getByRole('button', { name: 'New terminal' }).click()
  await expect(page).toHaveURL(/\/t\/[^/]+$/)
  const terminalURL = page.url()

  await page.reload()
  await expect(page).toHaveURL(terminalURL)
  await expect(page.getByRole('region', { name: 'Terminals' }).getByTestId('terminal-view')).toBeVisible()

  await page.goBack()
  await expect(page).toHaveURL(sessionURL)
  await expect(page.getByText(`echo: ${text}`)).toBeVisible()
})

test('terminal mode is a step of its own: its link opens it and Back returns to it', async ({ page }) => {
  await page.goto(`/terminal?token=${token}`)
  const terminal = page.getByRole('radio', { name: /^Terminal/ })
  await expect(terminal).toHaveAttribute('aria-checked', 'true')
  await page.getByRole('radio', { name: 'Diagnostics' }).click()
  await expect(page).toHaveURL(/\/diagnostics/)
  await page.goBack()
  await expect(terminal).toHaveAttribute('aria-checked', 'true')
  await expect(page).toHaveURL(/\/(terminal|t\/[^/?]+)(\?|$)/)
})
