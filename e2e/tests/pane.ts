import type { Page } from '@playwright/test'

// showPane opens a view on narrow screens, where only one pane is visible at
// a time; on desktop every pane is already shown and this is a no-op.
// showShells unfolds terminal mode's shell list on a phone, where it folds
// to one line while a shell is attached; elsewhere it is a no-op.
export async function showShells(page: Page) {
  const toggle = page.locator('.term-switch[aria-expanded="false"]')
  if (await toggle.isVisible()) await toggle.click()
}

export async function showPane(page: Page, name: 'Sessions' | 'Chat' | 'Requests') {
  const bar = page.getByRole('navigation', { name: 'Views' })
  if (await bar.isVisible()) await bar.getByRole('button', { name: new RegExp(`^${name}`) }).click()
}
