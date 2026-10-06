import baseSvg from '../../public/icon.svg?raw'

// The tab icon carries the same signal as the tab title: while an agent
// waits for the owner, the icon gains the amber requests mark in a corner.

const BASE_ICON = '/icon.svg'

const MARK = '<rect x="300" y="12" width="200" height="200" rx="16" fill="#e3a33a" stroke="#0f1012" stroke-width="24"/>'

export const ATTENTION_ICON = `data:image/svg+xml,${encodeURIComponent(baseSvg.trim().replace(/<\/svg>$/, `${MARK}</svg>`))}`

export function setAttentionIcon(on: boolean, doc: Document = document): void {
  const link = doc.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (!link) return
  const href = on ? ATTENTION_ICON : BASE_ICON
  if (link.getAttribute('href') !== href) link.setAttribute('href', href)
}
