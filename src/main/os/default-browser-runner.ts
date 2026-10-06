// The default-browser host wired to the real machine. Nothing here registers anything at start-up: the registration
// is made only when the person presses a button or ticks the box on the welcome screen.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { app, shell } from 'electron'
import { isSameProgram } from './default-browser.js'
import type { DefaultBrowserHost, Launcher } from './default-browser.js'
import { testDefaultBrowserHost } from './default-browser-test-seam.js'

/** Where Windows lists the apps that may be the default, with Orivon's own entry selected. */
const WINDOWS_DEFAULT_APPS = 'ms-settings:defaultapps?registeredAppUser=Orivon'

/** The installed package's desktop entry (`electron-builder.yml`): the name a default choice keys on. */
const DESKTOP_FILE = 'orivon.desktop'
const XDG_MIME_TIMEOUT_MS = 5000
const execFileAsync = promisify(execFile)

function launcher (): Launcher {
  if (!app.isPackaged) return 'source'
  return (process.env['APPIMAGE'] ?? '') !== '' ? 'appimage' : 'installed'
}

/** Windows keeps the choice per user in the registry, behind a hash; the system's own answer is the only reliable read. */
async function windowsDefault (protocol: string): Promise<boolean> {
  try {
    return isSameProgram((await app.getApplicationInfoForProtocol(`${protocol}://`)).path, process.execPath)
  } catch {
    return false
  }
}

const systemHost: DefaultBrowserHost = {
  get platform () { return process.platform },
  get launcher () { return launcher() },
  isDefault: async (protocol) => process.platform === 'win32' ? await windowsDefault(protocol) : app.isDefaultProtocolClient(protocol),
  setDefault: (protocol) => app.setAsDefaultProtocolClient(protocol),
  setDocumentDefault: async (mimeType) => {
    try {
      await execFileAsync('xdg-mime', ['default', DESKTOP_FILE, mimeType], { timeout: XDG_MIME_TIMEOUT_MS })
      return true
    } catch {
      return false
    }
  },
  openSettings: async () => { await shell.openExternal(WINDOWS_DEFAULT_APPS) }
}

export const defaultBrowserHost: DefaultBrowserHost = testDefaultBrowserHost() ?? systemHost
