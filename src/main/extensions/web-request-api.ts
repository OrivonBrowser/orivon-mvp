// chrome.webRequest's three calls: an extension registers a listener over the
// router and Orivon sends the matching requests back (web-request-dispatch.ts).
// The permission stays stripped from the loaded copy, so the router answers
// `webRequest` from the original record, and the dispatcher asks for
// `webRequestBlocking` the same way.
import { webContents } from 'electron'
import { readExtensionManifest } from '../../broker/policy/extension-manifest.js'
import { webRequestOwnerFor } from '../sessions/web-request-owner.js'
import type { ExtensionApiModule } from './api/api-types.js'
import { hostAccessForPatterns } from './extension-host-access.js'
import { isExtensionTab } from './extension-host.js'
import { createWebRequestDispatcher } from './web-request-dispatch.js'

/** The page's current URL; reading a page that is being destroyed can throw. */
function pageUrlOf (webContentsId: number): string | undefined {
  try {
    const contents = webContents.fromId(webContentsId)
    return contents === undefined || contents.isDestroyed() ? undefined : contents.getURL()
  } catch {
    return undefined
  }
}

export const webRequestApi: ExtensionApiModule = {
  name: 'webRequest',
  permission: 'webRequest',
  install: (ctx) => {
    // Read from the loaded manifest once per load, not once per request.
    const hostPermissions = new Map<string, readonly string[]>()
    const hostPermissionsOf = (id: string): readonly string[] | undefined => {
      const held = hostPermissions.get(id)
      if (held !== undefined) return held
      const manifest = ctx.session.extensions.getExtension(id)?.manifest
      if (manifest === undefined) return undefined
      const parsed = readExtensionManifest(manifest)
      const read = parsed.ok ? parsed.facts.hostPermissions : []
      hostPermissions.set(id, read)
      return read
    }
    const dispatcher = createWebRequestDispatcher({
      owner: webRequestOwnerFor(ctx.session),
      isTab: isExtensionTab,
      hostPermissionsOf,
      hostAccess: hostAccessForPatterns,
      isAppOrigin: ctx.isAppOrigin,
      pageUrlOf,
      held: ctx.held,
      installedAt: (id) => ctx.extensions()?.list().find((entry) => entry.id === id)?.installedAt ?? 0
    })
    ctx.session.extensions.on('extension-loaded', (_event, extension) => { hostPermissions.delete(extension.id) })
    ctx.session.extensions.on('extension-unloaded', (_event, extension) => {
      hostPermissions.delete(extension.id)
      dispatcher.dropExtension(extension.id)
    })
    ctx.handle('webRequest.addListener', (event, ...args) => { dispatcher.addListener(event, args[0], args[1], args[2], args[3]) })
    ctx.handle('webRequest.removeListener', (event, ...args) => { dispatcher.removeListener(event, args[0], args[1]) })
    ctx.handle('webRequest.reply', (event, ...args) => { dispatcher.reply(event, args[0], args[1]) })
  }
}
