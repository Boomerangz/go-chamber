import { test as base, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'

// A separate server keeps experimental v2 out of legacy protocol scenarios.
const test = base.extend<object, { v2: { url: string; dir: string } }>({
  v2: [async ({}, use) => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gc-v2-')))
    fs.writeFileSync(path.join(dir, 'token'), 'v2-test-token')
    const port = await new Promise<number>((resolve) => {
      const probe = net.createServer(); probe.listen(0, '127.0.0.1', () => { const port = (probe.address() as net.AddressInfo).port; probe.close(() => resolve(port)) })
    })
    const url = `http://127.0.0.1:${port}`
    const proc = spawn(path.resolve('../bin/go-chamber'), ['-addr', `127.0.0.1:${port}`, '-data', dir, '-terminal-v2', '-rtc-ice', '[]'], { env: { ...process.env, SHELL: '/bin/zsh', HOME: dir, ZDOTDIR: dir }, stdio: 'ignore' })
    try {
      await expect.poll(async () => { try { return (await fetch(`${url}/api/health`)).status } catch { return 0 } }, { timeout: 15000 }).toBe(401)
      await use({ url, dir })
    } finally { proc.kill('SIGTERM'); await new Promise<void>((resolve) => proc.once('exit', () => resolve())) }
  }, { scope: 'worker' }],
})

test('v2 sends subsequent keystrokes while earlier input ACKs are withheld', async ({ page, v2 }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'RTCPeerConnection', {value: undefined}))
  let ready = false
  let hold = true
  const frames: Buffer[] = []
  const acks: string[] = []
  let release: (() => void) | undefined
  await page.routeWebSocket('**/api/terminals/*/pty?*', (ws) => {
    const server = ws.connectToServer()
    release = () => { hold = false; for (const ack of acks.splice(0)) ws.send(ack) }
    ws.onMessage((message) => {
      if (typeof message !== 'string' && message[0] === 3) frames.push(Buffer.from(message))
      server.send(message)
    })
    server.onMessage((message) => {
      if (typeof message === 'string') {
        const {type} = JSON.parse(message) as {type: string}
        if (type === 'ready') ready = true
        if (type === 'inputAck' && hold) { acks.push(message); return }
      }
      ws.send(message)
    })
  })
  await page.goto(`${v2.url}/?token=v2-test-token`)
  const created = await page.request.post(`${v2.url}/api/terminals`, {data: {cwd: v2.dir}})
  const {id} = await created.json() as {id: string}
  await page.goto(`${v2.url}/t/${id}`)
  await expect.poll(() => ready).toBe(true)
  const view = page.getByTestId('terminal-view')
  await view.click()
  await page.keyboard.type('a')
  await expect.poll(() => acks.length).toBe(1)
  await page.keyboard.type('b')
  await expect.poll(() => acks.length).toBe(2)
  expect(frames.map((frame) => [Number(frame.readBigUInt64BE(9)), frame.subarray(17).toString()])).toEqual([[0, 'a'], [1, 'b']])
  await expect(view.locator('.xterm-rows').last()).toContainText('ab')
  release?.()
  await page.keyboard.press('Control+c')
  await page.keyboard.insertText("printf '\\npipeline-%s\\n' 42")
  await page.keyboard.press('Enter')
  await expect(view).toContainText('pipeline-42')
})

test('v2 restores after a lost input ACK without executing the command twice', async ({ page, v2 }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'RTCPeerConnection', {value: undefined}))
  let cutOnEnter = false
  let cut = false
  await page.routeWebSocket('**/api/terminals/*/pty?*', (ws) => {
    const server = ws.connectToServer()
    ws.onMessage((message) => {
      if (typeof message !== 'string' && message[0] === 3 && message.at(-1) === 13) cutOnEnter = true
      server.send(message)
    })
    server.onMessage((message) => {
      if (!cut && cutOnEnter && typeof message === 'string' && JSON.parse(message).type === 'inputAck') {
        cut = true; ws.close({ code: 1012 }); server.close(); return
      }
      ws.send(message)
    })
  })
  await page.goto(`${v2.url}/?token=v2-test-token`)
  await page.getByRole('radio', { name: /^Terminal/ }).click()
  await page.getByLabel('Terminal folder').fill(v2.dir)
  await page.getByRole('button', { name: 'New terminal' }).click()
  const view = page.getByTestId('terminal-view')
  await view.click()
  await page.keyboard.insertText("sleep 1; printf hit >> once.txt; printf '\\nrestored-%s\\n' 42")
  await page.keyboard.press('Enter')
  await expect.poll(() => cut).toBe(true)
  await expect(view.locator('.xterm-rows').last()).toContainText('restored-42')
  await expect(view.locator('.term-restore-image')).toHaveCount(0)
  expect(fs.readFileSync(path.join(v2.dir, 'once.txt'), 'utf8')).toBe('hit')
  await view.click(); await page.keyboard.insertText("printf '\\ncontinued-%s\\n' 42"); await page.keyboard.press('Enter')
  await expect(view).toContainText('continued-42')
})

test('v2 history is paged and searched without replaying into the interactive screen', async ({ page, v2 }) => {
  await page.goto(`${v2.url}/?token=v2-test-token`)
  const created = await page.request.post(`${v2.url}/api/terminals`, {data: {cwd: v2.dir, cols: 80, rows: 24}})
  const {id} = await created.json() as {id: string}
  await page.goto(`${v2.url}/t/${id}`)
  const view = page.getByTestId('terminal-view')
  await view.click()
  await page.keyboard.insertText("i=0; while [ $i -lt 260 ]; do printf 'history-%03d\\n' $i; i=$((i+1)); done; printf 'ready-%s\\n' 42")
  await page.keyboard.press('Enter')
  await expect(view).toContainText('ready-42')
  await page.getByRole('button', {name: 'Read terminal history'}).click()
  const reader = page.getByRole('region', {name: 'Terminal history'})
  await expect(reader.getByRole('button', {name: 'Load older'})).toBeVisible()
  await reader.getByRole('button', {name: 'Load older'}).click()
  await expect(reader).toContainText('history-000')
  await reader.getByLabel('Search terminal history').fill('history-042')
  await expect(reader.locator('pre')).toContainText('history-042')
  await expect(reader.locator('pre')).not.toContainText('history-043')
  await reader.getByRole('button', {name: 'Back to terminal'}).click()
  await view.click(); await page.keyboard.insertText("printf 'after-reader-%s\\n' 42"); await page.keyboard.press('Enter')
  await expect(view).toContainText('after-reader-42')
})

test('v2 first tab controls; another tab explicitly takes control', async ({ page, context, v2 }) => {
  await page.goto(`${v2.url}/?token=v2-test-token`)
  const response = await page.request.post(`${v2.url}/api/terminals`, { data: { cwd: v2.dir, cols: 80, rows: 24 } })
  const { id } = await response.json() as { id: string }
  await page.goto(`${v2.url}/t/${id}`)
  await expect(page.getByTestId('terminal-view')).toBeVisible()
  await expect(page.getByText('connecting…', { exact: true })).toHaveCount(0)
  const other = await context.newPage()
  await other.goto(`${v2.url}/t/${id}`)
  await expect(other.getByRole('button', { name: 'Take control' })).toBeVisible()
  await other.getByRole('button', { name: 'Take control' }).click()
  await expect(page.getByRole('button', { name: 'Take control' })).toBeVisible()
  await other.getByTestId('terminal-view').click()
  await other.keyboard.insertText("printf '\\nowned-%s\\n' 42"); await other.keyboard.press('Enter')
  await expect(other.getByTestId('terminal-view')).toContainText('owned-42')
  await expect(page.getByTestId('terminal-view')).toContainText('owned-42')
  await other.close()
})

test('v2 loses an RTC input ACK, falls back to WebSocket and retries RTC without duplicate input', async ({ page, v2 }) => {
  let sockets = 0
  await page.routeWebSocket('**/api/terminals/*/pty?*', (ws) => { sockets++; ws.connectToServer() })
  await page.addInitScript(() => {
    const state = { peers: [] as RTCPeerConnection[], arm: false, drop: false, cut: false }
    Object.assign(window, { __v2Fault: state })
    const Native = RTCPeerConnection
    window.RTCPeerConnection = class extends Native {
      constructor(config?: RTCConfiguration) { super(config); state.peers.push(this) }
      createDataChannel(label: string, options?: RTCDataChannelInit) {
        const channel = super.createDataChannel(label, options)
        if (label === 'terminal-control-v2') {
          const send = channel.send
          Object.defineProperty(channel, 'send', { value: (data: unknown) => {
            if (state.arm && ArrayBuffer.isView(data)) {
              const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
              if (bytes[0] === 3 && bytes.at(-1) === 13) state.drop = true
            }
            Reflect.apply(send, channel, [data])
          } })
          channel.addEventListener('message', (event) => {
            if (!state.cut && state.drop && typeof event.data === 'string' && JSON.parse(event.data).type === 'inputAck') {
              event.stopImmediatePropagation(); state.cut = true; this.close()
            }
          })
        }
        return channel
      }
    }
  })
  await page.goto(`${v2.url}/?token=v2-test-token`)
  const created = await page.request.post(`${v2.url}/api/terminals`, {data: {cwd: v2.dir}})
  const {id} = await created.json() as {id: string}
  await page.goto(`${v2.url}/t/${id}`)
  const fault = () => page.evaluate(() => {
    const state = (window as unknown as {__v2Fault: {peers: RTCPeerConnection[]; cut: boolean}}).__v2Fault
    return {connected: state.peers.some((p) => p.connectionState === 'connected'), peers: state.peers.length, cut: state.cut}
  })
  await expect.poll(async () => (await fault()).connected, {timeout: 15000}).toBe(true)
  await page.evaluate(() => { (window as unknown as {__v2Fault: {arm: boolean}}).__v2Fault.arm = true })
  const view = page.getByTestId('terminal-view')
  await view.click(); await page.keyboard.insertText("sleep 1; printf hit >> rtc-once.txt; printf '\\nrtc-restored-%s\\n' 42"); await page.keyboard.press('Enter')
  await expect.poll(async () => (await fault()).cut).toBe(true)
  await expect.poll(() => sockets).toBeGreaterThanOrEqual(2)
  await expect(view).toContainText('rtc-restored-42')
  expect(fs.readFileSync(path.join(v2.dir, 'rtc-once.txt'), 'utf8')).toBe('hit')
  await expect.poll(async () => { const s = await fault(); return s.peers >= 2 && s.connected }, {timeout: 15000}).toBe(true)
  await page.getByRole('radio', {name: 'Diagnostics', exact: true}).click()
  const metric = page.locator('article').filter({has: page.getByRole('heading', {name: 'WebRTC round trip', exact: true})})
  await expect(metric.locator('.diagnostic-value')).not.toContainText('—', {timeout: 10000})
})

test('v2 delayed echo is predicted only at a verified prompt; password input is never predicted', async ({ page, v2 }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'RTCPeerConnection', {value: undefined}))
  let pong = false
  await page.routeWebSocket('**/api/terminals/*/pty?*', (ws) => {
    const server = ws.connectToServer()
    ws.onMessage((message) => server.send(message))
    server.onMessage((message) => setTimeout(() => {
      try { ws.send(message); if (typeof message === 'string' && JSON.parse(message).type === 'pong') pong = true } catch { /* Page closed during delayed delivery. */ }
    }, 120))
  })
  await page.goto(`${v2.url}/?token=v2-test-token`)
  const created = await page.request.post(`${v2.url}/api/terminals`, {data: {cwd: v2.dir}})
  const {id} = await created.json() as {id: string}
  await page.goto(`${v2.url}/t/${id}`)
  const view = page.getByTestId('terminal-view')
  await expect.poll(() => pong, {timeout: 10000}).toBe(true)
  await view.click(); await page.keyboard.type('Q')
  await expect(view.locator('.xterm-rows').last()).toContainText('Q')
  await page.keyboard.type('b')
  await expect(view.getByTestId('terminal-prediction')).toBeVisible()
  await expect(view.getByTestId('terminal-prediction')).toHaveText('b')
  await expect(view.getByTestId('terminal-prediction')).toBeHidden()
  await page.keyboard.press('Control+c')
  await page.keyboard.insertText("read -r -s 'answer?Password: '; printf '\\npassword-done-%s\\n' 42")
  await page.keyboard.press('Enter')
  await expect(view.locator('.xterm-rows').last()).toContainText('Password:')
  await page.keyboard.type('not-a-command', {delay: 10})
  await expect(view.getByTestId('terminal-prediction')).toBeHidden()
  expect(await view.getByTestId('terminal-prediction').textContent()).toBe('')
  await page.keyboard.press('Enter')
  await expect(view).toContainText('password-done-42')
})

test('v2 bounds a stalled output window, resynchronizes flood and accepts Ctrl-C', async ({ page, v2 }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'RTCPeerConnection', {value: undefined}))
  let stall = false, bytes = 0
  let heldAck: string | undefined
  let release: (() => void) | undefined
  let snapshots = 0
  await page.routeWebSocket('**/api/terminals/*/pty?*', (ws) => {
    const server = ws.connectToServer()
    release = () => { stall = false; if (heldAck) server.send(heldAck); heldAck = undefined }
    ws.onMessage((message) => {
      if (stall && typeof message === 'string' && JSON.parse(message).type === 'ack') { heldAck = message; return }
      server.send(message)
    })
    server.onMessage((message) => {
      if (stall && typeof message !== 'string') bytes += message.length - 9
      if (typeof message === 'string' && JSON.parse(message).type === 'snapshot') snapshots++
      ws.send(message)
    })
  })
  await page.goto(`${v2.url}/?token=v2-test-token`)
  const created = await page.request.post(`${v2.url}/api/terminals`, {data: {cwd: v2.dir}})
  const {id} = await created.json() as {id: string}
  await page.goto(`${v2.url}/t/${id}`)
  const view = page.getByTestId('terminal-view')
  await expect.poll(() => snapshots).toBeGreaterThan(0)
  await view.click()
  await page.keyboard.insertText('while true; do printf "flood-%080d\\n" 42; done')
  stall = true
  await page.keyboard.press('Enter')
  await expect.poll(() => bytes).toBeGreaterThan(48 * 1024)
  // Wait for the existing 4 MiB server backlog threshold, without releasing
  // the 64 KiB application window or relying on machine-specific throughput.
  await expect.poll(async () => {
    const response = await page.request.get(`${v2.url}/api/diagnostics`)
    const data = await response.json() as {terminals: {id: string; laggedClients: number}[]}
    return data.terminals.find((t) => t.id === id)?.laggedClients ?? 0
  }, {timeout: 20000}).toBeGreaterThan(0)
  // Application ACKs are withheld, while the independent input path stays live.
  await page.keyboard.press('Control+c')
  await page.keyboard.insertText("printf '\\ninterrupt-ok-%s\\n' 42 > flood-result.txt")
  await page.keyboard.press('Enter')
  await expect.poll(() => fs.existsSync(path.join(v2.dir, 'flood-result.txt'))).toBe(true)
  expect(bytes).toBeLessThanOrEqual(64 * 1024)
  release?.()
  await expect.poll(() => snapshots).toBeGreaterThan(1)
  await expect(view.locator('.term-restore-image')).toHaveCount(0)
  await view.click(); await page.keyboard.insertText('cat flood-result.txt'); await page.keyboard.press('Enter')
  await expect(view).toContainText('interrupt-ok-42')
})

test('v2 shell to alternate-screen TUI to shell restores without polluting history', async ({ page, v2 }) => {
  await page.goto(`${v2.url}/?token=v2-test-token`)
  const created = await page.request.post(`${v2.url}/api/terminals`, {data: {cwd: v2.dir}})
  const {id} = await created.json() as {id: string}
  await page.goto(`${v2.url}/t/${id}`)
  const view = page.getByTestId('terminal-view')
  await view.click()
  await page.keyboard.insertText("printf '\\033[?1049h\\033[2J\\033[HTUI-%s\\n' 42; i=0; while [ $i -lt 100 ]; do printf 'private-tui-row-%s\\n' $i; i=$((i+1)); done; read -r answer; printf '\\033[?1049l\\nshell-again-%s\\n' 42")
  await page.keyboard.press('Enter')
  await expect(view).toContainText('private-tui-row-99')
  await expect(view.getByTestId('terminal-prediction')).toBeHidden()
  await page.reload()
  await expect(view).toContainText('private-tui-row-99')
  await page.getByRole('button', {name: 'Take control'}).click()
  await view.click(); await page.keyboard.press('Enter')
  await expect(view).toContainText('shell-again-42')
  await page.keyboard.insertText("i=0; while [ $i -lt 100 ]; do printf 'main-row-%s\\n' $i; i=$((i+1)); done")
  await page.keyboard.press('Enter')
  await expect(view).toContainText('main-row-99')
  const history = await page.request.get(`${v2.url}/api/terminals/${id}/history?q=private-tui-row-99`)
  expect((await history.json() as {lines: unknown[]}).lines).toEqual([])
})

test('v2 keeps WebSocket interactive while a delayed RTC answer completes direct connection', async ({ page, v2 }) => {
  test.setTimeout(45000)
  await page.addInitScript(() => {
    const peers: RTCPeerConnection[] = []
    Object.assign(window, {__delayedRTCPeers: peers})
    const Native = RTCPeerConnection
    window.RTCPeerConnection = class extends Native {
      constructor(config?: RTCConfiguration) { super(config); peers.push(this) }
    }
  })
  let held = false
  await page.route('**/api/terminals/*/rtc?*', async (route) => {
    const response = await route.fetch()
    held = true
    // The server is already checking ICE, but the browser has not received
    // its answer. This exceeded both old server and browser deadlines.
    await new Promise((resolve) => setTimeout(resolve, 13000))
    await route.fulfill({response})
  })
  await page.goto(`${v2.url}/?token=v2-test-token`)
  const created = await page.request.post(`${v2.url}/api/terminals`, {data: {cwd: v2.dir}})
  const {id} = await created.json() as {id: string}
  await page.goto(`${v2.url}/t/${id}`)
  await expect.poll(() => held).toBe(true)
  const view = page.getByTestId('terminal-view')
  await view.click(); await page.keyboard.insertText("printf '\\nws-during-negotiation-%s\\n' 42"); await page.keyboard.press('Enter')
  await expect(view).toContainText('ws-during-negotiation-42')
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as {__delayedRTCPeers: RTCPeerConnection[]}).__delayedRTCPeers.some((p) => p.connectionState === 'connected')
  ), {timeout: 25000}).toBe(true)
  await page.getByRole('radio', {name: 'Diagnostics', exact: true}).click()
  await expect(page.locator('td[data-label="Connection"]').filter({hasText: /^webrtc$/})).toHaveCount(1)
  const metric = page.locator('article').filter({has: page.getByRole('heading', {name: 'WebRTC round trip', exact: true})})
  await expect(metric.locator('.diagnostic-value')).not.toContainText('—', {timeout: 10000})
})
