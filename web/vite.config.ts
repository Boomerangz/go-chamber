/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The Go server (make dev) listens on 7777; vite proxies API and WS to it.
const backend = process.env.GC_BACKEND ?? 'http://127.0.0.1:7777'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: backend, ws: true },
    },
  },
  test: {
    // Mutation runners leave copies under .stryker-tmp; only source tests
    // belong in normal unit/coverage runs.
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/lib/**', 'src/stores/**', 'src/components/requests/**', 'src/components/folders/**', 'src/components/models/**'],
      exclude: ['**/*.test.*'],
      thresholds: { lines: 80, branches: 80 },
    },
  },
})
