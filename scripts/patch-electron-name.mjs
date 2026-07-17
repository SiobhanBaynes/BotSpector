// Dev-only: rename the prebuilt Electron.app so macOS shows "BotSpector" (not
// "Electron") in the dock and the bold menu-bar title during `npm run dev`.
//
// macOS derives that name from the running bundle's Info.plist CFBundleName,
// which app.setName() can't override at runtime. Packaged builds get the right
// name from electron-builder's productName, so this only matters for dev.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

if (process.platform !== 'darwin') process.exit(0)

const APP_NAME = 'BotSpector'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const appDir = join(root, 'node_modules', 'electron', 'dist', 'Electron.app')
const plist = join(appDir, 'Contents', 'Info.plist')

if (!existsSync(plist)) {
  console.log('[patch-electron-name] Electron.app not found; skipping')
  process.exit(0)
}

const plistBuddy = '/usr/libexec/PlistBuddy'

function setKey(key, value) {
  try {
    execFileSync(plistBuddy, ['-c', `Set :${key} ${value}`, plist])
  } catch {
    try {
      execFileSync(plistBuddy, ['-c', `Add :${key} string ${value}`, plist])
    } catch {
      // ignore — non-fatal
    }
  }
}

try {
  setKey('CFBundleName', APP_NAME)
  setKey('CFBundleDisplayName', APP_NAME)
  // Nudge Launch Services so the new name is picked up on next launch.
  try {
    execFileSync('/usr/bin/touch', [appDir])
    execFileSync(
      '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
      ['-f', appDir],
      { stdio: 'ignore' }
    )
  } catch {
    // lsregister is best-effort
  }
  console.log(`[patch-electron-name] dev app name set to "${APP_NAME}"`)
} catch (err) {
  console.log(`[patch-electron-name] skipped: ${err.message}`)
}
