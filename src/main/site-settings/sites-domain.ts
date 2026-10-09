// What the Settings page may ask of per-site settings: the defaults and the sites with an answer of their own, one
// site's rows, a change to one answer, forgetting a site and forgetting them all, and the devices a site was given (ADR-0068). A request is data from a document,
// so every field is checked, and the controller refuses an origin that is not an ordinary website or a kind that is
// not available. Pure over the controller it is handed.
import type { DeviceRows } from '../devices/hid-rows.js'
import type { InternalDomain } from '../pages/internal-ipc.js'
import type { SiteSettingsController } from './site-settings-controller.js'

interface Request {
  readonly type?: unknown
  readonly origin?: unknown
  readonly kind?: unknown
  readonly value?: unknown
  readonly key?: unknown
}

const hostOf = (origin: string): string => {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}

/** The origins whose first-visit question was answered Deny (`../install/declined-apps.ts`): listed here so the person can have it asked again. */
export interface DeclinedAppRows {
  list: () => string[]
  remove: (origin: string) => boolean
}

export function sitesDomain (controller: SiteSettingsController, options: { isPrivate: boolean, devices?: DeviceRows, declinedApps?: DeclinedAppRows }): InternalDomain {
  const devices = options.devices
  /** The sites with an answer, and the ones that only hold an approved device, each with how many devices (ADR-0068). */
  const sites = (): ReturnType<SiteSettingsController['sites']> => {
    const answered = controller.sites()
    if (devices === undefined) return answered
    const counts = new Map(devices.websites().map((site) => [site.origin, site.devices]))
    const merged = answered.map((site) => counts.has(site.origin) ? { ...site, devices: counts.get(site.origin) } : site)
    for (const [origin, count] of counts) {
      if (!answered.some((site) => site.origin === origin)) merged.push({ origin, kinds: [], devices: count })
    }
    return merged.sort((a, b) => hostOf(a.origin).localeCompare(hostOf(b.origin)) || a.origin.localeCompare(b.origin))
  }
  const rowsOf = (origin: string): { rows: ReturnType<SiteSettingsController['rowsFor']>, devices?: ReturnType<DeviceRows['siteRows']> } =>
    ({ rows: controller.rowsFor(origin), ...(devices === undefined ? {} : { devices: devices.siteRows(origin) }) })
  return {
    pages: ['settings'],
    handle: (command) => {
      const request = (typeof command === 'object' && command !== null ? command : {}) as Request
      switch (request.type) {
        case 'list':
          return { isPrivate: options.isPrivate, defaults: controller.defaults(), sites: sites(), declinedApps: options.declinedApps?.list() ?? [] }
        case 'rows':
          return typeof request.origin === 'string' ? rowsOf(request.origin) : undefined
        case 'set': {
          if (typeof request.origin !== 'string') return undefined
          const ok = controller.set(request.origin, request.kind, request.value)
          return { ok, ...rowsOf(request.origin) }
        }
        case 'forgetDevice': {
          if (typeof request.origin !== 'string' || typeof request.key !== 'string' || devices === undefined) return undefined
          const ok = devices.siteRows(request.origin).some((row) => row.key === request.key) && devices.forget(request.origin, request.key)
          return { ok, ...rowsOf(request.origin) }
        }
        case 'resetSite': {
          if (typeof request.origin !== 'string') return undefined
          const forgotten = devices?.forgetSite(request.origin) === true
          return { ok: controller.resetSite(request.origin) || forgotten }
        }
        case 'askAgain':
          return typeof request.origin === 'string' ? { ok: options.declinedApps?.remove(request.origin) === true } : undefined
        case 'resetAll':
          controller.resetAll()
          devices?.forgetAllWebsites()
          return { ok: true }
        default:
          return undefined
      }
    }
  }
}
