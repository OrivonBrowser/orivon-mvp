import { contextBridge, ipcRenderer } from 'electron'
import { injectExtensionAPIs } from './renderer'
import { getExtraMainWorldApis } from './renderer/extras'

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

// Orivon patch (UPSTREAM.md patch 37, opaque-origin fast path added by
// patch 40): a page listed in the extension's own manifest sandbox.pages
// (real Chrome's CSP `sandbox` -- extensions put untrusted code,
// templates, eval, there specifically because it gets no chrome.* API at
// all) keeps its chrome-extension:// URL, so contextUrl() alone cannot
// tell it apart from an ordinary extension page. extension-sandbox-csp.ts
// (src/main/extensions/) serves such a page with that same CSP `sandbox`
// directive, which DOES make this frame's real (Blink) security origin
// opaque -- measured directly, `self.origin` reads the literal string
// `"null"` there, same as real Chrome. `location.origin` does NOT reflect
// this on this Electron build (still the ordinary chrome-extension://<id>
// string) -- measured too, which is why this checks `self.origin`, never
// `location.origin`. Only a frame can be sandboxed (the manifest key has
// no service-worker equivalent), so this always answers false there
// without asking anything. The synchronous main-process query stays as the
// fallback: a page whose CSP the browser process has not yet finished
// applying when this preload script runs would otherwise slip through.
// EXTENSION_SANDBOX_PAGE_QUERY_CHANNEL's own literal is duplicated, not
// imported, from src/main/channels.ts -- that constant's own doc says why.
const SANDBOX_PAGE_QUERY_CHANNEL = 'orivon-extensions:sandbox-page-query'

function isSandboxPage(): boolean {
  if (process.type === 'service-worker') return false
  if (self.origin === 'null') return true
  try {
    return ipcRenderer.sendSync(SANDBOX_PAGE_QUERY_CHANNEL) === true
  } catch {
    return false
  }
}

if (contextUrl().startsWith('chrome-extension://') && !isSandboxPage()) {
  // Orivon patch (UPSTREAM.md patch 45): Orivon's own namespaces ride along.
  injectExtensionAPIs(getExtraMainWorldApis())
}
