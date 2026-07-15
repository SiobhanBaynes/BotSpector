import { app, BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { registerIpcHandlers } from './ipc'
import { getDb, closeDb } from './db/db'
import { disconnect as disconnectMcp } from './mcp/adoClient'

// Never let a broken stdout/stderr pipe (e.g. the launching terminal closed)
// crash the app with an uncaught EIO/EPIPE error.
process.stdout.on('error', () => {})
process.stderr.on('error', () => {})

// Pin a stable internal app name so OS-level, name-derived resources survive the
// rebrand. In particular, Electron's safeStorage encrypts secrets with a macOS
// Keychain key named "<app name> Safe Storage"; renaming the app would otherwise
// switch to a fresh key and make the existing encrypted secrets undecryptable.
// (The user-visible title is set on the BrowserWindow, so this stays hidden.)
app.setName('azdo-pr-reviewer')

// Pin a stable user-data directory so settings/DB survive app renames/rebrands.
// (Electron derives userData from the package name by default, so renaming the
// app would otherwise point it at a fresh, empty folder.)
app.setPath('userData', join(app.getPath('appData'), 'botspector'))

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'BotSpector',
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
  registerIpcHandlers()
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
