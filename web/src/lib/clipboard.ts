import { fail } from '../stores/notices'

// copyText puts text on the clipboard. Over plain http (a phone on the LAN)
// there is no Clipboard API, so it falls back to a hidden textarea.
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
    if (!legacyCopy(text)) throw new Error('The browser did not allow copying')
    return true
  } catch (err) {
    fail("Couldn't copy", err, 'copy')
    return false
  }
}

function legacyCopy(text: string): boolean {
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  try {
    return document.execCommand?.('copy') ?? false
  } finally {
    area.remove()
  }
}
