import { defineConfig, devices } from '@playwright/test'
import path from 'node:path'

// Terminal benchmarks: `npx playwright test -c bench.config.ts` after `make build`.
// Not part of the e2e suite: timings, not assertions.
const port = 7790
const repoRoot = path.resolve(process.cwd(), '..')
const fakesPath = path.join(repoRoot, 'bin', 'fakes')

export default defineConfig({
  testDir: './bench',
  testMatch: '*.bench.ts',
  workers: 1,
  timeout: 180_000,
  use: { baseURL: `http://127.0.0.1:${port}`, ...devices['Desktop Chrome'], viewport: { width: 1600, height: 1000 } },
  webServer: {
    command: `rm -rf .bench-data && mkdir -p .bench-data && echo e2e-token > .bench-data/token && SHELL=/bin/sh PATH="${fakesPath}:$PATH" ${process.env.BENCH_BIN ?? "../bin/go-chamber"} -addr 127.0.0.1:${port} -data .bench-data`,
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    timeout: 15_000,
  },
})
