import { defineConfig, devices } from '@playwright/test'
import path from 'node:path'

// E2E runs the real binary (make build) against a throwaway data dir with a
// fixed token. Agent CLIs are replaced by fakes from testutil/ (PATH override)
// so scenarios are deterministic and don't spend subscription quota.
const port = Number(process.env.E2E_PORT) || 7788
export const token = 'e2e-token'
const repoRoot = path.resolve(process.cwd(), '..')
const fakesPath = path.join(repoRoot, 'bin', 'fakes')

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 2,
  retries: 0,
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: [{command: `node fixtures/native-provider.mjs ${port+1}`, url: `http://127.0.0.1:${port+1}/health`, reuseExistingServer:false}, {
    command: `rm -rf .data && mkdir -p .data && echo ${token} > .data/token && mkdir -p .data/claude && cp -R fixtures/claude-projects .data/claude/projects && OPENROUTER_API_KEY=e2e-native FAKEOPENCODE_DATA=.data/opencode CLAUDE_CONFIG_DIR=.data/claude SHELL=/bin/sh PATH="${fakesPath}:$PATH" ../bin/go-chamber -addr 127.0.0.1:${port} -data .data -tmux=false -rtc-ice '[]' -native-openrouter-url http://127.0.0.1:${port+1}`,
    url: `http://127.0.0.1:${port}/api/health`,
    // Answers 401 without a token, which Playwright counts as ready.
    reuseExistingServer: false,
    timeout: 15_000,
  }],
})
