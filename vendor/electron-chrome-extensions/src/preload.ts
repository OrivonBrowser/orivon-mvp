import { contextBridge, ipcRenderer } from 'electron'
import { injectExtensionAPIs } from './renderer'

// Orivon patch (UPSTREAM.md 30): inject only into a chrome-extension: page
// or worker. A 'service-worker' preload runs in Electron's preload realm,
// which has no `location`, so a worker's own URL is read from its main world.
function contextUrl(): string {
  if (process.type !== 'service-worker') return location.href
  try {
    const href: unknown = contextBridge.executeInMainWorld({ func: () => self.location.href })
    return typeof href === 'string' ? href : ''
  } catch {
    return ''
  }
}

// Orivon patch (UPSTREAM.md patch 37): a page listed in the extension's own
// manifest sandbox.pages (real Chrome's CSP `sandbox` -- extensions put
// untrusted code, templates, eval, there specifically because it gets no
// chrome.* API at all) keeps its chrome-extension:// URL, so contextUrl()
// alone cannot tell it apart from an ordinary extension page. Measured
// directly on this Electron build: such a page's own `location.origin`
// stays the ordinary chrome-extension://<id> origin -- it does NOT become
// opaque ("null") the way real Chrome's CSP sandbox does -- so the opaque-
// origin check below is forward-compatible defence, never the mechanism
// that actually catches this today; the synchronous main-process query is.
// Only a frame can be sandboxed (the manifest key has no service-worker
// equivalent), so this always answers false there without asking anything.
// EXTENSION_SANDBOX_PAGE_QUERY_CHANNEL's own literal is duplicated, not
// imported, from src/main/channels.ts -- that constant's own doc says why.
const SANDBOX_PAGE_QUERY_CHANNEL = 'orivon-extensions:sandbox-page-query'

function isSandboxPage(): boolean {
  if (process.type === 'service-worker') return false
  if (location.origin === 'null') return true
  try {
    return ipcRenderer.sendSync(SANDBOX_PAGE_QUERY_CHANNEL) === true
  } catch {
    return false
  }
}

if (contextUrl().startsWith('chrome-extension://') && !isSandboxPage()) {
  injectExtensionAPIs()
}
