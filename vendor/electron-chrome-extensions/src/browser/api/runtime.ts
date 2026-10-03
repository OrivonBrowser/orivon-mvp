import { EventEmitter } from 'node:events'
import type { ExtensionContext } from '../context'
import type { ExtensionEvent } from '../router'
import { getExtensionManifest } from './common'
import type { BrowserActionAPI } from './browser-action'
import type { OffscreenAPI } from './offscreen'

/** developer.chrome.com/docs/extensions/reference/api/runtime#type-ExtensionContext --
 * `documentId` is left out: nothing here mints the UUID Chrome documents for
 * it, and no caller measured needs it. */
interface RuntimeContext {
  contextId: string
  contextType: 'TAB' | 'POPUP' | 'BACKGROUND' | 'OFFSCREEN_DOCUMENT'
  documentOrigin?: string | undefined
  documentUrl?: string
  frameId: number
  incognito: boolean
  tabId: number
  windowId: number
}

/** chrome.runtime.ContextFilter's own fields this implements -- `documentIds`
 * and `frameIds` are not, since nothing here mints a document id and every
 * context here is its own top frame. An unspecified field matches every
 * context (Chrome's own `{}` matches all rule). */
interface RuntimeContextFilter {
  contextTypes?: string[]
  contextIds?: string[]
  tabIds?: number[]
  windowIds?: number[]
  documentUrls?: string[]
  documentOrigins?: string[]
  incognito?: boolean
}

function matchesContextFilter (ctx: RuntimeContext, filter: RuntimeContextFilter): boolean {
  if (filter.contextTypes && !filter.contextTypes.includes(ctx.contextType)) return false
  if (filter.contextIds && !filter.contextIds.includes(ctx.contextId)) return false
  if (filter.tabIds && !filter.tabIds.includes(ctx.tabId)) return false
  if (filter.windowIds && !filter.windowIds.includes(ctx.windowId)) return false
  if (filter.documentUrls && (ctx.documentUrl === undefined || !filter.documentUrls.includes(ctx.documentUrl))) return false
  if (filter.documentOrigins && (ctx.documentOrigin === undefined || !filter.documentOrigins.includes(ctx.documentOrigin))) return false
  if (filter.incognito !== undefined && ctx.incognito !== filter.incognito) return false
  return true
}

function documentOriginOf (url: string): string | undefined {
  try {
    return new URL(url).origin
  } catch {
    return undefined
  }
}

export class RuntimeAPI extends EventEmitter {
  constructor(
    private ctx: ExtensionContext,
    private offscreen: OffscreenAPI,
    private browserAction: BrowserActionAPI,
  ) {
    super()

    const handle = this.ctx.router.apiHandler()
    handle('runtime.connectNative', this.connectNative, { permission: 'nativeMessaging' })
    handle('runtime.disconnectNative', this.disconnectNative, { permission: 'nativeMessaging' })
    handle('runtime.openOptionsPage', this.openOptionsPage)
    handle('runtime.sendNativeMessage', this.sendNativeMessage, { permission: 'nativeMessaging' })
    // Orivon patch (UPSTREAM.md, patch 32): absent from both Electron and
    // this library. Volume Master's own existence check for an offscreen
    // document ("is one already open") calls this first and falls back to
    // `clients.matchAll()` only `if (!('getContexts' in chrome.runtime))` --
    // measured directly, that fallback does NOT see a document this
    // library's `OffscreenAPI` creates, and the extension's own SECOND
    // `createDocument()` call then throws "Only a single offscreen document
    // may be created." A real `getContexts` is what Volume Master's own
    // code already prefers; this removes the whole failure class rather
    // than working around its fallback path. SIDE_PANEL and
    // DEVELOPER_TOOLS never appear: neither has a real implementation here.
    handle('runtime.getContexts', this.getContexts.bind(this))
  }

  private getContexts = async (
    { extension }: ExtensionEvent,
    filter: RuntimeContextFilter = {},
  ): Promise<RuntimeContext[]> => {
    const extensionId = extension.id
    const origin = `chrome-extension://${extensionId}`
    const contexts: RuntimeContext[] = []

    const running = this.ctx.session.serviceWorkers.getAllRunning()
    for (const [versionId, info] of Object.entries(running)) {
      if (!info.scope.startsWith(`${origin}/`)) continue
      contexts.push({
        contextId: `sw:${versionId}`, contextType: 'BACKGROUND',
        frameId: -1, incognito: false, tabId: -1, windowId: -1,
      })
    }

    const offscreenContents = this.offscreen.getDocumentWebContents(extensionId)
    if (offscreenContents !== undefined) {
      const url = offscreenContents.getURL()
      contexts.push({
        contextId: `offscreen:${String(offscreenContents.id)}`, contextType: 'OFFSCREEN_DOCUMENT',
        documentOrigin: documentOriginOf(url), documentUrl: url,
        frameId: 0, incognito: false, tabId: -1, windowId: -1,
      })
    }

    const popup = this.browserAction.getOpenPopup()
    if (popup !== undefined && popup.extensionId === extensionId) {
      const url = popup.webContents.getURL()
      contexts.push({
        contextId: `popup:${String(popup.webContents.id)}`, contextType: 'POPUP',
        documentOrigin: documentOriginOf(url), documentUrl: url,
        frameId: 0, incognito: false, tabId: popup.tabId, windowId: -1,
      })
    }

    for (const tab of this.ctx.store.tabs) {
      const url = tab.getURL()
      if (!url.startsWith(`${origin}/`)) continue
      const windowId = this.ctx.store.tabToWindow.get(tab)?.id ?? -1
      contexts.push({
        contextId: `tab:${String(tab.id)}`, contextType: 'TAB',
        documentOrigin: documentOriginOf(url), documentUrl: url,
        frameId: 0, incognito: false, tabId: tab.id, windowId,
      })
    }

    return contexts.filter((c) => matchesContextFilter(c, filter))
  }

  // Orivon patch (UPSTREAM.md, patch 1): native messaging starts a desktop program, native
  // code outside Orivon's broker. The handlers stay registered so an extension gets this
  // error instead of silently hanging.
  private connectNative = async (
    _event: ExtensionEvent,
    _connectionId: string,
    _application: string,
  ) => {
    throw new Error('Native messaging is not supported in Orivon')
  }

  private disconnectNative = (_event: ExtensionEvent, _connectionId: string) => {
    throw new Error('Native messaging is not supported in Orivon')
  }

  private sendNativeMessage = async (
    _event: ExtensionEvent,
    _application: string,
    _message: any,
  ) => {
    throw new Error('Native messaging is not supported in Orivon')
  }

  private openOptionsPage = async ({ extension }: ExtensionEvent) => {
    // TODO: options page shouldn't appear in Tabs API
    // https://developer.chrome.com/extensions/options#tabs-api

    const manifest = getExtensionManifest(extension)

    const page = manifest.options_ui ? manifest.options_ui.page : manifest.options_page
    if (!page) return

    // Embedded option not support (!options_ui.open_in_new_tab)
    const url = `chrome-extension://${extension.id}/${page}`
    // Orivon patch (UPSTREAM.md patch 67): the options page is one tab.
    if (this.ctx.store.impl.activateTabShowing?.(url)) return
    await this.ctx.store.createTab({ url, active: true })
  }
}
