// The default-browser host wired to the real machine. Nothing here registers anything at start-up: the registration
// is made only when the person presses a button or ticks the box on the welcome screen.
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app, shell } from 'electron'
import { isSameProgram } from './default-browser.js'
import type { DefaultBrowserHost, Launcher } from './default-browser.js'
import { isTestBuild, testDefaultBrowserHost } from './default-browser-test-seam.js'
import { xdgDataHome } from './site-shortcut-runner.js'
import { aumidOfHandler, isSameStoreApp, isStoreInstall, progIdOf, storeAumid } from './windows-store.js'

/** Where Windows lists the apps that may be the default, with Orivon's own entry selected. */
const WINDOWS_DEFAULT_APPS = 'ms-settings:defaultapps?registeredAppUser=Orivon'
/** A package registers no `RegisteredApplications` entry under that name, so a Store install opens the page's top. */
const WINDOWS_DEFAULT_APPS_STORE = 'ms-settings:defaultapps'

/** The installed package's desktop entry (`electron-builder.yml`): the name a default choice keys on. */
const DESKTOP_FILE = 'orivon.desktop'
/** A run from source's own entry, which `scripts/launch-from-source.mjs install` writes. */
const SOURCE_DESKTOP_FILE = 'orivon-source.desktop'
const XDG_TIMEOUT_MS = 5000
const execFileAsync = promisify(execFile)

function launcher (): Launcher {
  if (!app.isPackaged) return 'source'
  return (process.env['APPIMAGE'] ?? '') !== '' ? 'appimage' : 'installed'
}

const linuxSource = (): boolean => process.platform === 'linux' && launcher() === 'source'

/** This checkout's entry, when the person's applications folder holds one that starts it. */
function sourceEntry (): string | undefined {
  if (isTestBuild()) return undefined
  try {
    const text = readFileSync(join(xdgDataHome(process.env, homedir()), 'applications', SOURCE_DESKTOP_FILE), 'utf8')
    return text.includes(join(app.getAppPath(), 'scripts', 'launch-from-source.mjs')) ? SOURCE_DESKTOP_FILE : undefined
  } catch {
    return undefined
  }
}

function desktopEntry (): string | undefined {
  if (process.platform !== 'linux') return undefined
  return linuxSource() ? sourceEntry() : DESKTOP_FILE
}

/** One `reg query` for a value, printed as text; undefined when the key or the value is not there. */
async function registryQuery (key: string, value: string): Promise<string | undefined> {
  try {
    return (await execFileAsync('reg', ['query', key, '/v', value], { timeout: XDG_TIMEOUT_MS, windowsHide: true })).stdout
  } catch {
    return undefined
  }
}

/** A packaged handler is no path: the person's choice names an AppX program id, whose `Application` key holds the
 * package's AUMID, the one this package would have. Provisional: written from Microsoft's documentation of the
 * registry, unmeasured on a Store install. */
async function windowsStoreDefault (protocol: string): Promise<boolean> {
  const choice = await registryQuery(`HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\${protocol}\\UserChoice`, 'ProgId')
  const progId = progIdOf(choice ?? '')
  if (progId === undefined) return false
  const handler = await registryQuery(`HKCR\\${progId}\\Application`, 'AppUserModelID')
  return isSameStoreApp(aumidOfHandler(handler ?? ''), storeAumid(process.execPath))
}

/** Windows keeps the choice per user in the registry, behind a hash; the system's own answer is the only reliable read. */
async function windowsDefault (protocol: string): Promise<boolean> {
  if (isStoreInstall()) return await windowsStoreDefault(protocol)
  try {
    return isSameProgram((await app.getApplicationInfoForProtocol(`${protocol}://`)).path, process.execPath)
  } catch {
    return false
  }
}

/** Runs one of the freedesktop.org tools, and says whether it succeeded and what it printed. */
async function xdg (tool: 'xdg-mime' | 'xdg-settings', args: string[]): Promise<string | undefined> {
  try {
    return (await execFileAsync(tool, args, { timeout: XDG_TIMEOUT_MS })).stdout.trim()
  } catch {
    return undefined
  }
}

// Electron's own calls name the installed package's entry (`desktopName` in package.json); a run from source names its
// own, with the same tool Electron runs.
const systemHost: DefaultBrowserHost = {
  get platform () { return process.platform },
  get launcher () { return launcher() },
  get desktopEntry () { return desktopEntry() },
  isDefault: async (protocol) => {
    if (process.platform === 'win32') return await windowsDefault(protocol)
    if (linuxSource()) return await xdg('xdg-settings', ['check', 'default-url-scheme-handler', protocol, SOURCE_DESKTOP_FILE]) === 'yes'
    return app.isDefaultProtocolClient(protocol)
  },
  setDefault: async (protocol) => linuxSource()
    ? await xdg('xdg-settings', ['set', 'default-url-scheme-handler', protocol, SOURCE_DESKTOP_FILE]) !== undefined
    : app.setAsDefaultProtocolClient(protocol),
  setDocumentDefault: async (mimeType) => await xdg('xdg-mime', ['default', desktopEntry() ?? DESKTOP_FILE, mimeType]) !== undefined,
  openSettings: async () => { await shell.openExternal(isStoreInstall() ? WINDOWS_DEFAULT_APPS_STORE : WINDOWS_DEFAULT_APPS) }
}

export const defaultBrowserHost: DefaultBrowserHost = testDefaultBrowserHost() ?? systemHost
