import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

test('launches the BotSpector desktop shell', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'botspector-smoke-'))
  const executablePath = process.env.BOTSPECTOR_EXECUTABLE
  const app = await electron.launch({
    ...(executablePath ? { executablePath } : { args: ['.'] }),
    cwd: process.cwd(),
    env: {
      ...process.env,
      BOTSPECTOR_USER_DATA_DIR: userDataDir,
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
    }
  })

  try {
    const window = await app.firstWindow()
    await expect(window).toHaveTitle('BotSpector')
    await expect(window.locator('#root .app')).toBeVisible()
    await expect(window.locator('.brand')).toContainText('BotSpector')
    await expect(
      window.getByRole('navigation').getByRole('button', { name: 'Settings' })
    ).toBeVisible()
  } finally {
    await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
