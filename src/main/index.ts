import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'

// Main and preload are CommonJS; only the renderer is ESM. This is
// electron-vite's default and it is kept deliberately, for one reason:
// sandboxed preload scripts have no ESM context at all -- they run as plain
// JavaScript and load electron via require. `sandbox: true` is non-negotiable
// here, so the preload must be CJS, and matching main to it avoids a
// two-format build for no gain.
//
// For the record, because it would otherwise be assumed: an ESM main process
// works fine. `import { app, BrowserWindow } from 'electron'` was verified
// against Electron 44 on 2026-08-25 and returns the real API. If a future
// need for ESM in main appears, nothing here blocks it.

// The webPreferences below are load-bearing, not boilerplate.
//
// `contextIsolation: true` is what makes capability-api.md's central rule
// free: the preload holds a socket's raw MessagePort in the isolated world
// and exposes only closures. Transferring that port to the page -- the
// obvious move when optimising for throughput -- would hand a raw socket to
// anything the page can reach (security-model.md T17).
//
// A hookify rule rejects edits that weaken these.
function createWindow (): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  win.once('ready-to-show', () => win.show())

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl !== undefined) {
    void win.loadURL(devServerUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

void app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
