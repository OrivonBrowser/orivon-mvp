// The per-site asker the permission gate consults: Electron's permission
// names and details in, the engine's kinds out. It answers `undefined` for
// every name it does not own, and for any contents that is not an ordinary
// tab, so an extension's page, a shell view and an embed keep the gate's own
// rules.
import type { WebContents } from 'electron'
import type { SiteAsker } from '../sessions/site-asks.js'
import { checkOf, requestOf } from './electron-names.js'
import type { CheckDetails, RequestDetails, SiteAsksEngine } from './site-asks-engine.js'

function detailsOf<D extends object> (details: unknown): D {
  return (typeof details === 'object' && details !== null ? details : {}) as D
}

export function createSiteAsker (engine: SiteAsksEngine<WebContents>): SiteAsker {
  return {
    name: 'site-permissions',
    request (contents, permission, details) {
      const request = requestOf(permission, details)
      return request === undefined ? undefined : engine.request(request, contents, detailsOf<RequestDetails>(details))
    },
    check (contents, permission, requestingOrigin, details) {
      const kind = checkOf(permission, details)
      return kind === undefined ? undefined : engine.check(kind, contents, requestingOrigin, detailsOf<CheckDetails>(details))
    }
  }
}
