import type { Page } from '@playwright/test'

// showPane opens a view on narrow screens, where only one pane is visible at
// a time; on desktop every pane is already shown and this is a no-op.
export async function showPane(page: Page, name: 'Sessions' | 'Chat' | 'Requests') {
  const bar = page.getByRole('navigation', { name: 'Views' })
  if (await bar.isVisible()) await bar.getByRole('button', { name: new RegExp(`^${name}`) }).click()
}
