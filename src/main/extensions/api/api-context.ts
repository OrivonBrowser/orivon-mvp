// Builds the context one API module receives (api-types.ts). Everything
// Electron- or shell-specific a module may need is reached through a
// dependency passed in here, so a module's own unit test supplies a fake
// context and never touches this file.
import type { Session, WebContents } from 'electron'
import type { ElectronChromeExtensions } from 'orivon:crx-extensions'
import type { ShellServices } from '../../shell/shell-services.js'
import type { ExtensionsApi } from '../extensions-subsystem.js'
import type { ExtensionPrefsStore } from '../extension-prefs.js'
import { hostAccessFor } from '../extension-host-access.js'
import { registerEventPermission } from '../extension-event-filter.js'
import type { ExtensionApiContext, ExtensionApiModule, ResolvedTab } from './api-types.js'

export interface ExtensionApiDeps {
  readonly host: ElectronChromeExtensions
  readonly session: Session
  readonly userDataPath: string
  readonly shell: () => ShellServices | undefined
  /** Defaults to running `run` only when the shell already exists. */
  readonly onShell?: (run: (shell: ShellServices) => void) => void
  readonly extensions: () => ExtensionsApi | undefined
  readonly prefs: ExtensionPrefsStore
  readonly held: (extensionId: string, permission: string) => boolean
  readonly isAppOrigin: (url: string) => boolean
  /** `webContents.fromId`, injected so this file needs no electron runtime. */
  readonly webContentsFromId: (id: number) => WebContents | undefined
}

function liveTab (deps: ExtensionApiDeps, contents: WebContents | undefined): ResolvedTab | undefined {
  if (contents === undefined || contents.isDestroyed()) return undefined
  const found = deps.shell()?.windows.findTab(contents)
  return found == null ? undefined : { contents, window: found.window, id: found.tabId }
}

export function createApiContext (deps: ExtensionApiDeps, module: ExtensionApiModule): ExtensionApiContext {
  const handleOnRouter = deps.host.getRouter().apiHandler()
  const tab = (tabId: unknown): ResolvedTab | undefined => {
    if (typeof tabId !== 'number' || !Number.isInteger(tabId) || tabId < 0) return undefined
    return liveTab(deps, deps.webContentsFromId(tabId))
  }
  return {
    handle: (name, run, opts) => {
      const permission = opts !== undefined && 'permission' in opts ? opts.permission : module.permission
      handleOnRouter(name, run, permission === undefined ? {} : { permission })
    },
    sendEvent: (extensionId, name, ...args) => { deps.host.getRouter().sendEvent(extensionId, name, ...args) },
    host: deps.host,
    session: deps.session,
    userDataPath: deps.userDataPath,
    shell: deps.shell,
    onShell: deps.onShell ?? ((run) => {
      const shell = deps.shell()
      if (shell !== undefined) run(shell)
    }),
    extensions: deps.extensions,
    prefs: deps.prefs,
    held: deps.held,
    tab,
    activeTab: (windowId) => {
      const windows = deps.shell()?.windows
      if (windows === undefined) return undefined
      const target = typeof windowId === 'number' && windowId >= 0
        ? windows.all().find((entry) => !entry.window.isDestroyed() && entry.window.id === windowId)
        : windows.focused()
      return target === undefined ? undefined : liveTab(deps, target.tabs.activeWebContents())
    },
    canSee: (extensionId, contents) => {
      const manifest = deps.session.extensions.getExtension(extensionId)?.manifest
      return manifest != null && hostAccessFor(extensionId, manifest, contents.getURL(), contents.id)
    },
    isAppOrigin: deps.isAppOrigin
  }
}

/** Runs every module once. A module's `permission` is also what its events
 * need: the event filter drops an event of `<name>.*` for an extension that
 * does not hold it. */
export function installExtensionApis (deps: ExtensionApiDeps, modules: readonly ExtensionApiModule[]): void {
  for (const module of modules) {
    if (module.permission !== undefined) registerEventPermission(module.name, module.permission)
    module.install(createApiContext(deps, module))
  }
}
