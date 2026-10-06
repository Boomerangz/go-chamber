import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import { token } from '../playwright.config'
import { openNewSession, showPane, showSessionDetails } from './pane'

async function newSession(page: Page, agent: 'Claude' | 'Codex') {
  const dir = fs.realpathSync(fs.mkdtempSync(`${os.tmpdir()}/gc-mode-`))
  await showPane(page, 'Sessions')
  await openNewSession(page)
  await page.getByRole('radio', { name: agent }).click()
  await page.getByLabel('Working directory').fill(dir)
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByLabel('Message')).toBeVisible()
}

async function say(page: Page, text: string) {
  await page.getByLabel('Message').fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
}

test('switches the Claude permission mode and approves a plan', async ({ page }) => {
  await page.goto(`/?token=${token}`)
  await newSession(page, 'Claude')
  await showSessionDetails(page)
  await page.getByLabel('Permission mode').selectOption('plan')
  await say(page, 'current mode?')
  await expect(page.locator('.item.assistant', { hasText: 'mode: plan' })).toBeVisible()

  await say(page, 'make a plan')
  const card = page.locator('.request', { hasText: 'Ready to code?' })
  await expect(card.getByRole('heading', { name: 'Plan' })).toBeVisible()
  await card.getByRole('button', { name: 'Allow', exact: true }).click()
  await expect(page.locator('.request')).toHaveCount(0)

  // Switches live in the running CLI.
  await showSessionDetails(page)
  await page.getByLabel('Permission mode').selectOption('acceptEdits')
  await say(page, 'current mode?')
  await expect(page.locator('.item.assistant', { hasText: 'mode: acceptEdits' })).toBeVisible()

  // New sessions of the agent start in the last chosen mode.
  await newSession(page, 'Claude')
  await showSessionDetails(page)
  await expect(page.getByLabel('Permission mode')).toHaveValue('acceptEdits')
})

test('runs Codex commands without asking in full access', async ({ page }) => {
  await page.goto(`/?token=${token}`)
  await newSession(page, 'Codex')
  await showSessionDetails(page)
  await page.getByLabel('Permission mode').selectOption('full-access')
  await page.getByRole('group', { name: /^Confirm/ }).getByRole('button', { name: 'Switch' }).click()
  await expect(page.locator('.chat-meta .no-approvals')).toBeVisible()
  await say(page, 'current mode?')
  await expect(page.locator('.item.assistant', { hasText: 'mode: never dangerFullAccess' })).toBeVisible()
})

test('restores configured Codex approvals after full access', async ({ page }) => {
  await page.goto(`/?token=${token}`)
  await newSession(page, 'Codex')
  await showSessionDetails(page)
  await page.getByLabel('Permission mode').selectOption('full-access')
  await page.getByRole('group', { name: /^Confirm/ }).getByRole('button', { name: 'Switch' }).click()
  await expect(page.locator('.chat-meta .no-approvals')).toBeVisible()
  await say(page, 'current mode?')
  await expect(page.locator('.item.assistant', { hasText: 'mode: never dangerFullAccess' })).toBeVisible()
  await expect(page.locator('.chat-meta .status', { hasText: 'idle' })).toBeVisible()
  await showSessionDetails(page)
  await page.getByLabel('Permission mode').selectOption('')
  await say(page, 'current mode?')
  await expect(page.locator('.item.assistant', { hasText: 'mode: on-request workspaceWrite' })).toBeVisible()
  await expect(page.locator('.chat-meta .status', { hasText: 'idle' })).toBeVisible()
  await say(page, 'permission to run a command')
  await expect(page.locator('.request')).toBeVisible()
})
