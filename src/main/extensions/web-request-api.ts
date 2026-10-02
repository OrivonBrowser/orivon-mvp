// chrome.webRequest's three calls: an extension registers a listener over the
// router and Orivon sends the matching requests back (web-request-dispatch.ts).
// The permission stays stripped from the loaded copy, so the router answers
// `webRequest` from the original record, and the dispatcher asks for
// `webRequestBlocking` the same way.
import { webRequestOwnerFor } from '../sessions/web-request-owner.js'
import type { ExtensionApiModule } from './api/api-types.js'
import { hostAccessFor } from './extension-host-access.js'
import { isExtensionTab } from './extension-host.js'
import { createWebRequestDispatcher } from './web-request-dispatch.js'

export const webRequestApi: ExtensionApiModule = {
  name: 'webRequest',
  permission: 'webRequest',
  install: (ctx) => {
    const dispatcher = createWebRequestDispatcher({
      owner: webRequestOwnerFor(ctx.session),
      isTab: isExtensionTab,
      manifestOf: (id) => ctx.session.extensions.getExtension(id)?.manifest,
      hostAccess: (id, manifest, url, tabId) => hostAccessFor(id, manifest, url, tabId),
      held: ctx.held,
      installedAt: (id) => ctx.extensions()?.list().find((entry) => entry.id === id)?.installedAt ?? 0
    })
    ctx.session.extensions.on('extension-unloaded', (_event, extension) => { dispatcher.dropExtension(extension.id) })
    ctx.handle('webRequest.addListener', (event, ...args) => { dispatcher.addListener(event, args[0], args[1], args[2], args[3]) })
    ctx.handle('webRequest.removeListener', (event, ...args) => { dispatcher.removeListener(event, args[0], args[1]) })
    ctx.handle('webRequest.reply', (event, ...args) => { dispatcher.reply(event, args[0], args[1]) })
  }
}
