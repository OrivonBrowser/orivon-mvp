// What the Settings page may ask of per-site settings: the defaults and the sites with an answer of their own, one
// site's rows, a change to one answer, forgetting a site and forgetting them all. A request is data from a document,
// so every field is checked, and the controller refuses an origin that is not an ordinary website or a kind that is
// not available. Pure over the controller it is handed.
import type { InternalDomain } from '../pages/internal-ipc.js'
import type { SiteSettingsController } from './site-settings-controller.js'

interface Request {
  readonly type?: unknown
  readonly origin?: unknown
  readonly kind?: unknown
  readonly value?: unknown
}

export function sitesDomain (controller: SiteSettingsController, options: { isPrivate: boolean }): InternalDomain {
  return {
    pages: ['settings'],
    handle: (command) => {
      const request = (typeof command === 'object' && command !== null ? command : {}) as Request
      switch (request.type) {
        case 'list':
          return { isPrivate: options.isPrivate, defaults: controller.defaults(), sites: controller.sites() }
        case 'rows':
          return typeof request.origin === 'string' ? { rows: controller.rowsFor(request.origin) } : undefined
        case 'set': {
          if (typeof request.origin !== 'string') return undefined
          const ok = controller.set(request.origin, request.kind, request.value)
          return { ok, rows: controller.rowsFor(request.origin) }
        }
        case 'resetSite':
          return typeof request.origin === 'string' ? { ok: controller.resetSite(request.origin) } : undefined
        case 'resetAll':
          controller.resetAll()
          return { ok: true }
        default:
          return undefined
      }
    }
  }
}
