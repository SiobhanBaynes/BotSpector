import { join } from 'path'

interface AppIconPathOptions {
  isPackaged: boolean
  resourcesPath: string
  cwd: string
  platform: NodeJS.Platform
}

export function resolveAppIconPath({
  isPackaged,
  resourcesPath,
  cwd,
  platform
}: AppIconPathOptions): string {
  const iconName = platform === 'win32' ? 'icon.ico' : 'icon.png'
  return isPackaged ? join(resourcesPath, iconName) : join(cwd, 'build', iconName)
}
