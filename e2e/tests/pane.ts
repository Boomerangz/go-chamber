import { expect, type Page } from '@playwright/test'

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
  if (!narrow(page)) return
  // Decided by the width, not by the bar's visibility at this instant: the
  // bar steps aside while a field is being typed in, and comes back a
  // moment after the tap that took the focus away.
  const bar = page.getByRole('navigation', { name: 'Views' })
  await expect(bar).toBeVisible()
  await bar.getByRole('button', { name: new RegExp(`^${name}`) }).click()
}

// narrow is the phone layout: one pane at a time, the pane bar at the foot.
export function narrow(page: Page): boolean {
  return page.viewportSize()!.width <= 720
}

// showSessionDetails unfolds the session header on narrow screens, where the
// folder, model, mode and fork sit behind "⋯"; elsewhere it is a no-op.
export async function showSessionDetails(page: Page) {
  // The chat is open once its composer is; only then is the header complete.
  await page.getByLabel('Message').waitFor()
  const more = page.getByRole('button', { name: 'Session details' })
  if ((await more.isVisible()) && (await more.getAttribute('aria-expanded')) !== 'true') await more.click()
}

// openNewSession unfolds the new-session form on a phone, where it folds to
// one line so the sessions own the screen; elsewhere it is a no-op.
export async function openNewSession(page: Page) {
  const open = page.locator('.new-session-open')
  await open.waitFor({ state: 'attached' })
  if ((await open.isVisible()) && (await open.getAttribute('aria-expanded')) === 'false') await open.click()
}

// showAccounts unfolds the logins on a phone, where they fold to one line
// under the sessions; elsewhere it is a no-op.
export async function showAccounts(page: Page) {
  const fold = page.locator('.accounts-fold')
  if ((await fold.isVisible()) && (await fold.getAttribute('aria-expanded')) === 'false') await fold.click()
}
