import { contextBridge } from 'electron'
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

if (contextUrl().startsWith('chrome-extension://')) {
  injectExtensionAPIs()
}
