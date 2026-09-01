import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: {
    timeout: 10_000
  },
  outputDir: 'test-results/playwright',
  reporter: process.env.CI
    ? [
        ['line'],
        [
          'junit',
          {
            outputFile:
              process.env.PLAYWRIGHT_JUNIT_OUTPUT_FILE ?? 'test-results/playwright-junit.xml'
          }
        ]
      ]
    : 'line',
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  }
})
