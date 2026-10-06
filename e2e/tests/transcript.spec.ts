import { expect, test, type Page } from '@playwright/test'
import { token } from '../playwright.config'
import { showPane } from './pane'

async function newSession(page: Page) {
  await page.goto(`/?token=${token}`)
  await page.getByLabel('working directory').fill('/tmp')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect(page.getByLabel('message')).toBeVisible()
}

async function say(page: Page, text: string) {
  await page.getByLabel('message').fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
}

test('folds a run of reads and draws an edit as a diff', async ({ page }) => {
  await newSession(page)
  await say(page, 'edit some files')
  await expect(page.locator('.item.assistant', { hasText: 'edited a.go' })).toBeVisible()

  await expect(page.locator('.tool-group-label')).toHaveText('Read 3 files')
  const file = page.locator('.item.file', { hasText: '/src/a.go' })
  await expect(file.locator('.diff-stat')).toHaveText('+2 −1')
  await file.locator('summary', { hasText: 'Diff' }).click()
  await expect(file.locator('.idiff-del')).toHaveText(/y := 2/)
  await expect(file.locator('.idiff-add').last()).toHaveText(/z := 4/)
  // Each finished turn ends with what it cost.
  await expect(page.locator('.turn-foot')).toBeVisible()
})

test('sends a failed turn again with Retry', async ({ page }) => {
  await newSession(page)
  await say(page, 'fail this turn')
  const failed = page.locator('.item-error', { hasText: 'API Error: overloaded' })
  await expect(failed).toBeVisible()
  await failed.getByRole('button', { name: 'Retry' }).click()
  await expect(page.getByLabel('turn 2')).toBeVisible()
  await expect(page.locator('.item.user', { hasText: 'fail this turn' })).toHaveCount(2)
})

test('takes a sent message back into the composer', async ({ page }, info) => {
  await newSession(page)
  await say(page, 'hello there')
  const message = page.locator('.item.user', { hasText: 'hello there' })
  await expect(page.locator('.item.assistant', { hasText: 'echo: hello there' })).toBeVisible()
  if (info.project.name === 'mobile') {
    // No hover on a phone: the actions stay out of the way until a tap on the message.
    await expect(message.getByRole('button', { name: 'Edit' })).toBeHidden()
    await message.locator('.user-text').click()
  } else {
    await message.hover()
  }
  await message.getByRole('button', { name: 'Edit' }).click()
  await expect(page.getByLabel('message')).toHaveValue('hello there')
})

test('does not mark the owner\'s own messages as new', async ({ page }, info) => {
  const first = `seen ${info.project.name} one`
  await newSession(page)
  await say(page, first)
  await expect(page.locator('.item.assistant', { hasText: `echo: ${first}` })).toBeVisible()

  // Back after a reload, everything was read; what follows is on screen.
  await page.reload()
  await showPane(page, 'Sessions')
  await page.locator('.session', { hasText: first }).click()
  await expect(page.locator('.item.assistant', { hasText: `echo: ${first}` })).toBeVisible()
  await say(page, 'and again')
  await expect(page.locator('.item.assistant', { hasText: 'echo: and again' })).toBeVisible()
  await expect(page.locator('.unseen-mark')).toHaveCount(0)
})

test('a request takes focus so its keys answer, and says what a session grant adds', async ({ page }) => {
  await newSession(page)
  await say(page, 'please permission')
  const card = page.locator('.request.permission')
  await expect(card).toBeFocused()
  await expect(card.locator('.request-command')).toHaveText('please permission')
  await expect(card.locator('.request-grants')).toHaveText('for session: adds rule: Bash')
  // Keys typed right after the card took focus from the composer don't count.
  await page.waitForTimeout(700)
  await page.keyboard.press('a')
  await expect(page.locator('.item.assistant', { hasText: /approved: run/ })).toBeVisible()
})

test('picks a question option by its number', async ({ page }) => {
  await newSession(page)
  await say(page, 'ask me something')
  await expect(page.getByRole('radio', { name: /Alpha/ })).toBeFocused()
  await page.waitForTimeout(700)
  await page.keyboard.press('2')
  await expect(page.getByRole('radio', { name: /Beta/ })).toBeChecked()
  await page.getByRole('button', { name: 'Submit' }).click()
  const record = page.locator('.item.decision.decision-answer')
  await expect(record).toContainText('Which option should we use? Beta')
  await expect(record.locator('.decision-name')).toHaveCount(0)
})

test('skips a question', async ({ page }) => {
  await newSession(page)
  await say(page, 'ask me something')
  await page.getByRole('button', { name: 'Skip' }).click()
  await expect(page.locator('.request')).toHaveCount(0)
})
