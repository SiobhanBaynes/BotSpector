import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { registerIpcHandlers } from './ipc'
import { getDb, closeDb } from './db/db'
import { resetStuckReviews, recomputeAllReviewStatuses } from './db/repo'
import { disconnect as disconnectMcp } from './mcp/adoClient'
import { fixEnvPath } from './fixPath'
import { resolveAppIconPath } from './appIcon'

// A GUI app launched from Finder/Dock gets a minimal PATH that omits Node
// managers (nvm/fnm/Homebrew), which breaks spawning `npx` for the MCP server.
// Restore the real shell PATH before anything tries to spawn a child process.
// (Only needed for the packaged app; dev is launched from a terminal.)
if (app.isPackaged) fixEnvPath()

// Never let a broken stdout/stderr pipe (e.g. the launching terminal closed)
// crash the app with an uncaught EIO/EPIPE error.
process.stdout.on('error', () => {})
process.stderr.on('error', () => {})

// Set the user-visible app name so macOS menus (About/Hide/Quit) read "BotSpector".
// Note: on macOS this is also the key that Electron's safeStorage uses for the
// Keychain entry, so secrets encrypted under the old name won't decrypt — the PAT
// and Copilot sign-in are re-entered once. The database/settings are unaffected
// because userData is pinned separately below.
app.setName('BotSpector')

// Pin a stable user-data directory so settings/DB survive app renames/rebrands.
// (Electron derives userData from the package name by default, so renaming the
// app would otherwise point it at a fresh, empty folder.)
app.setPath(
  'userData',
  process.env.BOTSPECTOR_USER_DATA_DIR || join(app.getPath('appData'), 'botspector')
)

function createWindow(): void {
  const appIcon = resolveAppIconPath({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    cwd: process.cwd(),
    platform: process.platform
  })
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'BotSpector',
    ...(existsSync(appIcon) ? { icon: appIcon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())

  // Open external links in the default browser instead of a new Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  getDb() // initialize DB + run migrations early
  resetStuckReviews() // recover any review left 'reviewing' by a prior crash/restart
  recomputeAllReviewStatuses() // apply the "reviewed only when fully triaged" rule
  registerIpcHandlers()

  // In development the app runs from the prebuilt Electron binary, so the dock
  // shows Electron's icon. Override it with our own. (Packaged builds get the
  // icon from electron-builder, so this only matters for `npm run dev`.)
  if (!app.isPackaged && process.platform === 'darwin' && app.dock) {
    const devIcon = join(process.cwd(), 'build', 'icon.png')
    if (existsSync(devIcon)) {
      try {
        app.dock.setIcon(devIcon)
      } catch {
        // non-fatal
      }
    }
  }

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void disconnectMcp()
  closeDb()
})
