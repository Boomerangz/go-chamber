import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// A Claude-like full repaint: synchronized output, clear screen and
// scrollback, then the whole transcript reprinted with colours, box drawing
// and emoji. BENCH_LINES / BENCH_ROUNDS tune it; BENCH_FILE replays captured
// output instead.
const lines = Number(process.env.BENCH_LINES ?? 3000)
const rounds = Number(process.env.BENCH_ROUNDS ?? 5)

function frame(): string {
  let out = '\x1b[?2026h\x1b[2J\x1b[3J\x1b[H'
  for (let i = 0; i < lines; i++) {
    out += `\x1b[38;5;${(i % 200) + 16}m╭─ ⏺ line ${i} \x1b[1mtool\x1b[22m call · reading src/components/file${i}.tsx ✅ 🚀\x1b[0m ${'─'.repeat(40)}╮\r\n`
  }
  return out + `\x1b[?2026l`
}

async function openTerminal(page: Page, dir: string) {
  await page.goto('/?token=e2e-token')
  await page.getByRole('radio', { name: /^Terminal/ }).click()
  const panel = page.getByRole('region', { name: 'Terminals' })
  await panel.getByLabel('terminal directory').fill(dir)
  await panel.getByRole('button', { name: 'New terminal' }).click()
  const screen = panel.getByTestId('terminal-view')
  await screen.click()
  return { panel, screen }
}

// waitShown resolves once text is drawn on the terminal screen.
async function waitShown(page: Page, text: string) {
  await page.waitForFunction(
    (t) => (document.querySelector('[data-testid="terminal-view"] .xterm-rows')?.textContent ?? '').includes(t),
    text,
    { timeout: 120_000, polling: 'raf' },
  )
}

test('full-screen repaint of a long transcript', async ({ page }) => {
  const dir = fs.realpathSync(fs.mkdtempSync(`${os.tmpdir()}/gc-bench-`))
  const file = process.env.BENCH_FILE ?? path.join(dir, 'frame.txt')
  if (!process.env.BENCH_FILE) fs.writeFileSync(file, frame())
  const size = fs.statSync(file).size
  // Counting frames through the page listener would ship every payload over
  // CDP and slow the page down, so only sockets are counted.
  let sockets = 0
  page.on('websocket', (ws) => {
    if (ws.url().includes('/pty')) sockets++
  })
  await page.addInitScript(() => {
    const w = window as unknown as { longTasks: number[] }
    w.longTasks = []
    new PerformanceObserver((l) => l.getEntries().forEach((e) => w.longTasks.push(e.duration))).observe({ type: 'longtask', buffered: true })
  })
  await openTerminal(page, dir)
  await page.keyboard.type('echo ready\n')
  await waitShown(page, 'ready')

  const times: number[] = []
  for (let r = 0; r < rounds; r++) {
    await page.evaluate(() => ((window as unknown as { longTasks: number[] }).longTasks = []))
    // Typing key by key would add a round trip per character to the timing.
    await page.keyboard.insertText(`cat ${file}; echo MARK-$((${r}+1000))`)
    const start = Date.now()
    await page.keyboard.press('Enter')
    await waitShown(page, `MARK-${r + 1000}`)
    times.push(Date.now() - start)
  }
  const longTasks: number[] = await page.evaluate(() => (window as unknown as { longTasks: number[] }).longTasks)
  const sorted = [...times].sort((a, b) => a - b)
  console.log(
    `repaint ${lines} lines, ${(size / 1024).toFixed(0)} KiB: ms per round ${times.join(', ')}; median ${sorted[Math.floor(sorted.length / 2)]}; ` +
      `pty sockets ${sockets}; long tasks in last round ${longTasks.length} (max ${Math.max(0, ...longTasks).toFixed(0)} ms)`,
  )

  // Remounting with a full scrollback: leave to agent mode and come back.
  const start = Date.now()
  await page.getByRole('radio', { name: 'Agents' }).click()
  await page.getByRole('radio', { name: /^Terminal/ }).click()
  await page.getByTestId('terminal-view').click()
  await page.keyboard.insertText('echo BACK-$((1+1))')
  await page.keyboard.press('Enter')
  await waitShown(page, 'BACK-2')
  console.log(`mode switch and back, then echo: ${Date.now() - start} ms; pty sockets ${sockets}`)
  expect(times.length).toBe(rounds)
})

