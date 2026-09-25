import { defineConfig, devices } from '@playwright/test'
import path from 'node:path'

// E2E runs the real binary (make build) against a throwaway data dir with a
// fixed token. Agent CLIs are replaced by fakes from testutil/ (PATH override)
// so scenarios are deterministic and don't spend subscription quota.
const port = 7788
export const token = 'e2e-token'
const repoRoot = path.resolve(process.cwd(), '..')
const fakesPath = path.join(repoRoot, 'bin', 'fakes')

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  retries: 0,
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: `rm -rf .data && mkdir -p .data && echo ${token} > .data/token && SHELL=/bin/sh PATH="${fakesPath}:$PATH" ../bin/go-chamber -addr 127.0.0.1:${port} -data .data`,
    url: `http://127.0.0.1:${port}/api/health`,
    // Answers 401 without a token, which Playwright counts as ready.
    reuseExistingServer: false,
    timeout: 15_000,
  },
})
