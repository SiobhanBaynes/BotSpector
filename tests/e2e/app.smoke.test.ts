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
    await expect(window.locator('.repository-profile-editor')).toHaveCount(0)
    await window.getByRole('button', { name: 'Add repository' }).click()
    let editor = window.locator('.repository-profile-editor')
    await expect(editor).toBeVisible()
    await editor.getByLabel('Nickname').fill('Web')
    await editor.getByLabel('Organization').fill('contoso')
    await editor.getByLabel('Project').fill('DillonWay')
    await editor.getByLabel('Repository').fill('web-app')
    await editor.getByLabel('Personal Access Token').fill('web-credential-for-smoke-test')
    await editor.getByRole('button', { name: 'Save repository' }).click()

    const repositorySelector = window.locator('#active-repository')
    await expect(repositorySelector.locator('option')).toHaveText(['Web'])
    await expect(repositorySelector.locator('option:checked')).toHaveText('Web')
    await expect(
      window.locator('.repository-profile-row').filter({ hasText: 'Web' })
    ).toContainText('PAT saved')
    await expect(window.locator('.repository-profile-editor')).toHaveCount(0)

    const webProfile = window.locator('.repository-profile-item').filter({ hasText: 'Web' })
    await webProfile.getByRole('button', { name: 'Edit' }).click()
    await expect(webProfile.locator('.repository-profile-editor')).toBeVisible()
    await webProfile.getByRole('button', { name: 'Close' }).click()
    await expect(webProfile.locator('.repository-profile-editor')).toHaveCount(0)

    await window.getByRole('button', { name: 'Add repository' }).click()
    editor = window.locator('.repository-profile-editor')
    await editor.getByLabel('Nickname').fill('API')
    await editor.getByLabel('Organization').fill('contoso')
    await editor.getByLabel('Project').fill('DillonWay')
    await editor.getByLabel('Repository').fill('api')
    await editor.getByLabel('Personal Access Token').fill('api-credential-for-smoke-test')
    await editor.getByRole('button', { name: 'Save repository' }).click()

    await expect(repositorySelector.locator('option')).toHaveText(['API', 'Web'])
    await repositorySelector.selectOption({ label: 'API' })
    await expect(repositorySelector.locator('option:checked')).toHaveText('API')
  } finally {
    await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
