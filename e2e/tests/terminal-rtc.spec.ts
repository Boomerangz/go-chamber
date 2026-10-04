import { expect, test } from '@playwright/test'
import { token } from '../playwright.config'

test('uses a direct DataChannel and restores WebSocket after peer loss', async ({ page }) => {
 await page.addInitScript(() => {
  const NativePeer = RTCPeerConnection
  const peers: RTCPeerConnection[] = []
  Object.defineProperty(window, '__testPeers', { value: peers })
  window.RTCPeerConnection = class extends NativePeer {
   constructor(config?: RTCConfiguration) { super(config); peers.push(this) }
  }
 })
 await page.goto(`/?token=${token}`)
 await page.getByRole('radio', { name: /^Terminal/ }).click()
 const panel = page.getByRole('region', { name: 'Terminals' })
 await panel.getByLabel('terminal directory').fill('/tmp')
 await panel.getByRole('button', { name: 'New terminal' }).click()
 await page.getByRole('radio', { name: 'Diagnostics' }).click()
 const table = page.getByRole('region', { name: 'Terminal diagnostics' })
 await expect(table).toContainText('webrtc', { timeout: 15000 })
 await expect(table).toContainText('direct · udp')
 const rtc = page.locator('.diagnostic-metric', { has: page.getByRole('heading', { name: 'WebRTC round trip' }) })
 await expect(rtc.locator('.diagnostic-value')).not.toContainText('—')
 await page.getByRole('radio', { name: /^Terminal/ }).click()
 const screen = panel.getByTestId('terminal-view')
 await screen.click()
 await page.keyboard.type('echo p2p-$((20+22))\n')
 await expect(screen.locator('.xterm-rows')).toContainText('p2p-42')
 await page.evaluate(() => { (window as unknown as { __testPeers: RTCPeerConnection[] }).__testPeers[0].close() })
 await page.getByRole('radio', { name: 'Diagnostics' }).click()
 await expect(table).toContainText('websocket')
 await page.getByRole('radio', { name: /^Terminal/ }).click()
 await expect(screen.locator('.xterm-rows')).toContainText('p2p-42')
 await screen.click()
 await page.keyboard.type('echo fallback-$((10+5))\n')
 await expect(screen.locator('.xterm-rows')).toContainText('fallback-15')
 await page.keyboard.type('exit 0\n')
 await expect(screen.locator('.xterm-rows')).toContainText('process exited with code 0')
})

test('keeps the terminal usable when signaling is unavailable', async ({ page }) => {
 await page.route('**/api/rtc/config', (route) => route.fulfill({ status: 503, body: '{}' }))
 await page.goto(`/?token=${token}`)
 await page.getByRole('radio', { name: /^Terminal/ }).click()
 const panel = page.getByRole('region', { name: 'Terminals' })
 await panel.getByLabel('terminal directory').fill('/tmp')
 await panel.getByRole('button', { name: 'New terminal' }).click()
 const screen = panel.getByTestId('terminal-view')
 await screen.click()
 await page.keyboard.type('echo ws-$((1+2))\n')
 await expect(screen.locator('.xterm-rows')).toContainText('ws-3')
 await page.getByRole('radio', { name: 'Diagnostics' }).click()
 await expect(page.getByRole('region', { name: 'Terminal diagnostics' })).toContainText('websocket')
 await expect(page.getByRole('region', { name: 'Terminal diagnostics' })).toContainText('config · http · HTTP 503')
})


test('opens a direct channel with available candidates while gathering remains pending', async ({ page }) => {
 await page.addInitScript(() => {
  const NativePeer = RTCPeerConnection
  window.RTCPeerConnection = class extends NativePeer {
   override get iceGatheringState(): RTCIceGatheringState { return 'gathering' }
  }
 })
 await page.goto(`/?token=${token}`)
 await page.getByRole('radio', { name: /^Terminal/ }).click()
 const panel = page.getByRole('region', { name: 'Terminals' })
 await panel.getByLabel('terminal directory').fill('/tmp')
 await panel.getByRole('button', { name: 'New terminal' }).click()
 await page.getByRole('radio', { name: 'Diagnostics' }).click()
 const table = page.getByRole('region', { name: 'Terminal diagnostics' })
 await expect(table).toContainText('webrtc', { timeout: 12000 })
 await expect(table).toContainText('direct · udp')
 await expect(table).toContainText('open')
 await page.getByRole('radio', { name: /^Terminal/ }).click()
 const screen = panel.getByTestId('terminal-view')
 await screen.click()
 await page.keyboard.type('echo gathered-$((6*7))\n')
 await expect(screen.locator('.xterm-rows')).toContainText('gathered-42')
})
