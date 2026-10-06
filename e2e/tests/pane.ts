import type { Page } from '@playwright/test'

// showPane opens a view on narrow screens, where only one pane is visible at
// a time; on desktop every pane is already shown and this is a no-op.
// showShells unfolds terminal mode's shell list on a phone, where it folds
// to one line while a shell is attached; elsewhere it is a no-op.
export async function showShells(page: Page) {
  if ((page.viewportSize()?.width ?? Infinity) > 720) return
  // The switcher appears once a shell attaches; wait for it rather than
  // racing a terminal that is still opening.
  const toggle = page.locator('.term-switch')
  await toggle.waitFor()
  if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click()
}

export async function showPane(page: Page, name: 'Sessions' | 'Chat' | 'Requests') {
  const bar = page.getByRole('navigation', { name: 'Views' })
  if (await bar.isVisible()) await bar.getByRole('button', { name: new RegExp(`^${name}`) }).click()
}

// showSessionDetails unfolds the session header on narrow screens, where the
// folder, model, mode and fork sit behind "⋯"; elsewhere it is a no-op.
export async function showSessionDetails(page: Page) {
  // The chat is open once its composer is; only then is the header complete.
  await page.getByLabel('message').waitFor()
  const more = page.getByRole('button', { name: 'session details' })
  if ((await more.isVisible()) && (await more.getAttribute('aria-expanded')) !== 'true') await more.click()
}
