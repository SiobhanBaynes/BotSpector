import { describe, expect, it } from 'vitest'
import { join } from 'path'
import { resolveAppIconPath } from '../../src/main/appIcon'

describe('app icon path', () => {
  it('resolves packaged icons from the Electron resources directory', () => {
    expect(
      resolveAppIconPath({
        isPackaged: true,
        resourcesPath: join('installed', 'resources'),
        cwd: join('launch', 'directory'),
        platform: 'win32'
      })
    ).toBe(join('installed', 'resources', 'icon.ico'))
  })

  it('resolves development icons from the project build directory', () => {
    expect(
      resolveAppIconPath({
        isPackaged: false,
        resourcesPath: join('electron', 'resources'),
        cwd: join('project', 'root'),
        platform: 'linux'
      })
    ).toBe(join('project', 'root', 'build', 'icon.png'))
  })
})
