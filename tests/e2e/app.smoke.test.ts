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

    await window.getByRole('navigation').getByRole('button', { name: 'Settings' }).click()
    const editor = window.locator('.repository-profile-editor')
    await editor.getByLabel('Nickname').fill('Web')
    await editor.getByLabel('Organization').fill('contoso')
    await editor.getByLabel('Project').fill('DillonWay')
    await editor.getByLabel('Repository').fill('web-app')
    await editor.getByRole('button', { name: 'Save repository' }).click()

    const repositorySelector = window.locator('#active-repository')
    await expect(repositorySelector.locator('option')).toHaveText(['Web'])
    await expect(repositorySelector.locator('option:checked')).toHaveText('Web')

    await window.getByRole('button', { name: 'Add repository' }).click()
    await editor.getByLabel('Nickname').fill('API')
    await editor.getByLabel('Organization').fill('contoso')
    await editor.getByLabel('Project').fill('DillonWay')
    await editor.getByLabel('Repository').fill('api')
    await editor.getByRole('button', { name: 'Save repository' }).click()

    await expect(repositorySelector.locator('option')).toHaveText(['API', 'Web'])
    await repositorySelector.selectOption({ label: 'API' })
    await expect(repositorySelector.locator('option:checked')).toHaveText('API')
  } finally {
    await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
