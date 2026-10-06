// Registers the extension API modules and the one permission check, once,
// from extensionsSubsystem.afterReady and before the first extension loads:
// a handler registered later would still work, but an extension's worker
// that starts first and calls it would find none.
import { webContents } from 'electron'
import type { Session } from 'electron'
import type { ElectronChromeExtensions } from 'orivon:crx-extensions'
import { setPermissionCheck } from 'orivon:crx-extensions-router'
import { originFromUrl } from '../../../broker/policy/origin.js'
import type { SubsystemContext } from '../../registry.js'
import { shellServices, whenShellServices } from '../extension-host.js'
import { createBaseManifestCache, setBaseManifestSource } from '../base-manifest-source.js'
import { readBaseManifestText } from '../effective-manifest-runner.js'
import { getCachedStrippedPermissions, slotDirForLoadedExtension } from '../extensions-dnr.js'
import { parentOf } from '../extension-popup-policy.js'
import { sidePanelWindowOf } from '../side-panel-pages.js'
import { installPermissionCheck, type PermissionHeld } from '../extension-permission-check.js'
import type { ExtensionPrefsStore } from '../extension-prefs.js'
import { installExtensionApis } from './api-context.js'
import { EXTENSION_APIS } from './api-registry.js'

export interface InstallApisOptions {
  readonly host: ElectronChromeExtensions
  readonly session: Session
  readonly userDataPath: string
  readonly ctx: SubsystemContext
  readonly prefs: ExtensionPrefsStore
}

export function installApis (options: InstallApisOptions): PermissionHeld {
  const { host, session, userDataPath, ctx, prefs } = options
  const bases = createBaseManifestCache({
    readText: (id) => {
      const slotDir = slotDirForLoadedExtension(userDataPath, id)
      return slotDir === undefined ? undefined : readBaseManifestText(slotDir)
    }
  })
  session.extensions.on('extension-loaded', (_event, extension) => { bases.invalidate(extension.id) })
  session.extensions.on('extension-unloaded', (_event, extension) => { bases.invalidate(extension.id) })
  setBaseManifestSource(bases.baseOf)
  const held = installPermissionCheck({
    stripped: getCachedStrippedPermissions,
    manifestPermissions: (id) => {
      const base = bases.baseOf(id) ?? session.extensions.getExtension(id)?.manifest
      return (base as { permissions?: string[] } | undefined)?.permissions
    },
    prefs
  }, setPermissionCheck)
  installExtensionApis({
    host,
    session,
    userDataPath,
    shell: shellServices,
    onShell: whenShellServices,
    extensions: () => ctx.extensions,
    prefs,
    held,
    isAppOrigin: (url) => {
      const origin = originFromUrl(url)
      return origin !== null && ctx.broker?.app.hasGrantsSync(origin) === true
    },
    webContentsFromId: (id) => webContents.fromId(id),
    popupParent: (contents) => parentOf(contents) ?? sidePanelWindowOf(contents)
  }, EXTENSION_APIS)
  return held
}
