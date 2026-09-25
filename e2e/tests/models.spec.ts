import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import { token } from '../playwright.config'
import { showPane } from './pane'

async function newSession(page: Page, agent: 'Claude' | 'Codex') {
  const dir = fs.realpathSync(fs.mkdtempSync(`${os.tmpdir()}/gc-model-`))
  await showPane(page, 'Sessions')
  await page.getByRole('radio', { name: agent }).click()
  await page.getByLabel('working directory').fill(dir)
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByLabel('message')).toBeVisible()
}

async function pick(page: Page, group: 'model' | 'effort', name: RegExp | string) {
  const menu = page.getByRole('dialog', { name: 'Choose model' })
  if (!(await menu.isVisible())) await page.getByRole('button', { name: /^Model:/ }).click()
  await menu.getByRole('radiogroup', { name: group }).getByRole('radio', { name, exact: typeof name === 'string' }).click()
}

async function ask(page: Page, expected: string) {
  await page.getByLabel('message').fill('which model?')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.locator('.item.assistant', { hasText: expected }).last()).toBeVisible()
}

test('chooses the Claude model before and during a session', async ({ page }) => {
  await page.goto(`/?token=${token}`)
  await newSession(page, 'Claude')
  await pick(page, 'model', /^Opus/)
  await expect(page.getByRole('button', { name: 'Model: Opus' })).toBeVisible()
  await ask(page, 'model: opus effort: ')

  // A model switches live; effort restarts the CLI with --effort.
  await pick(page, 'model', /^Sonnet/)
  await ask(page, 'model: sonnet effort: ')
  await pick(page, 'effort', 'high')
  await expect(page.getByRole('button', { name: 'Model: Sonnet · high' })).toBeVisible()
  await page.keyboard.press('Escape')
  await ask(page, 'model: sonnet effort: high')
})

test('chooses the Codex model and remembers it for new sessions', async ({ page }) => {
  await page.goto(`/?token=${token}`)
  await newSession(page, 'Codex')
  await ask(page, 'model:  effort: ')
  await pick(page, 'model', /^Fake-small/)
  await pick(page, 'effort', 'low')
  await page.keyboard.press('Escape')
  await ask(page, 'model: fake-small effort: low')

  await newSession(page, 'Codex')
  await expect(page.getByRole('button', { name: 'Model: Fake-small · low' })).toBeVisible()
  await ask(page, 'model: fake-small effort: low')
})
