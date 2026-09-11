import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const packageVersion = (
  JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version: string }
).version
const escapedPackageVersion = packageVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const expectedBuildNumber = process.env.BOTSPECTOR_BUILD_NUMBER || process.env.BUILD_BUILDNUMBER
const expectedBuildId = process.env.BUILD_BUILDID
const expectedCommit =
  process.env.BOTSPECTOR_SOURCE_COMMIT ||
  process.env.SYSTEM_PULLREQUEST_SOURCECOMMITID ||
  process.env.BUILD_SOURCEVERSION

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
    await expect(window.locator('.build-version')).toHaveText(
      new RegExp(`^v${escapedPackageVersion} · (#[0-9]+|[0-9a-fA-F]{8}\\*?|unknown)$`)
    )
    await expect(window.locator('.build-version')).toHaveAttribute(
      'title',
      /Commit ([0-9a-fA-F]{40}|unknown)/
    )
    if (expectedBuildId) {
      await expect(window.locator('.build-version')).toHaveText(
        `v${packageVersion} · #${expectedBuildId}`
      )
    }
    await expect(
      window.getByRole('navigation').getByRole('button', { name: 'Settings' })
    ).toBeVisible()

    await window.getByRole('navigation').getByRole('button', { name: 'Settings' }).click()
    const buildDetails = window.getByLabel('Build information')
    const buildValues = buildDetails.locator('dd')
    await expect(buildValues).toHaveCount(4)
    await expect(buildValues.nth(0)).toHaveText(`v${packageVersion}`)
    await expect(buildValues.nth(1)).toHaveText(/.+/)
    await expect(buildValues.nth(2)).toHaveText(
      /^([0-9a-fA-F]{40}|unknown)( \(dirty working tree\))?$/
    )
    await expect(buildValues.nth(3)).toHaveText(/.+/)
    if (expectedBuildNumber) await expect(buildValues.nth(1)).toContainText(expectedBuildNumber)
    if (expectedBuildId) await expect(buildValues.nth(1)).toContainText(`#${expectedBuildId}`)
    if (expectedCommit) await expect(buildValues.nth(2)).toContainText(expectedCommit)
    await expect(window.locator('.repository-profile-editor')).toHaveCount(0)
    await window.getByRole('button', { name: 'Add repository' }).click()
    let editor = window.locator('.repository-profile-editor')
    await expect(editor).toBeVisible()
    await editor.getByLabel('Nickname').fill('Web')
    await editor.getByLabel('Organization').fill('contoso')
    await editor.getByLabel('Project').fill('DillonWay')
    await editor.getByLabel('Repository').fill('web-app')
    await editor.getByLabel('Your identity').fill('Siobhan Web')
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
    await expect(webProfile.locator('.repository-profile-details')).toContainText('Siobhan Web')
    await webProfile.getByRole('button', { name: 'Edit' }).click()
    await expect(webProfile.locator('.repository-profile-editor')).toBeVisible()
    await expect(webProfile.getByLabel('Your identity')).toHaveValue('Siobhan Web')
    await webProfile.getByRole('button', { name: 'Close' }).click()
    await expect(webProfile.locator('.repository-profile-editor')).toHaveCount(0)

    await window.getByRole('button', { name: 'Add repository' }).click()
    editor = window.locator('.repository-profile-editor')
    await editor.getByLabel('Nickname').fill('API')
    await editor.getByLabel('Organization').fill('contoso')
    await editor.getByLabel('Project').fill('DillonWay')
    await editor.getByLabel('Repository').fill('api')
    await editor.getByLabel('Your identity').fill('Siobhan API')
    await editor.getByLabel('Personal Access Token').fill('api-credential-for-smoke-test')
    await editor.getByRole('button', { name: 'Save repository' }).click()

    await expect(repositorySelector.locator('option')).toHaveText(['API', 'Web'])
    await repositorySelector.selectOption({ label: 'API' })
    await expect(repositorySelector.locator('option:checked')).toHaveText('API')

    const apiProfile = window.locator('.repository-profile-item').filter({ hasText: 'API' })
    await apiProfile.getByRole('button', { name: 'Edit' }).click()
    await expect(apiProfile.getByLabel('Your identity')).toHaveValue('Siobhan API')
    await apiProfile.getByRole('button', { name: 'Close' }).click()
    await webProfile.getByRole('button', { name: 'Edit' }).click()
    await expect(webProfile.getByLabel('Your identity')).toHaveValue('Siobhan Web')
  } finally {
    await app.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
