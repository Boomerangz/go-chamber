// The tab icon carries the same signal as the tab title: while an agent
// waits for the owner, the icon gains the amber requests mark.

const BASE_ICON = '/icon.svg'

const attentionSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">' +
  '<rect width="512" height="512" rx="112" fill="#0f1012"/>' +
  '<path d="M136 168l104 88-104 88" fill="none" stroke="#f3f3f1" stroke-width="44" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M272 352h112" stroke="#8ab4ff" stroke-width="44" stroke-linecap="round"/>' +
  '<rect x="300" y="12" width="200" height="200" rx="16" fill="#e3a33a" stroke="#0f1012" stroke-width="24"/>' +
  '</svg>'

export const ATTENTION_ICON = `data:image/svg+xml,${encodeURIComponent(attentionSvg)}`

export function setAttentionIcon(on: boolean, doc: Document = document): void {
  const link = doc.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (!link) return
  const href = on ? ATTENTION_ICON : BASE_ICON
  if (link.getAttribute('href') !== href) link.setAttribute('href', href)
}
