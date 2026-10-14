// What the Settings page may ask about the apps: every app the broker knows, with a switch per capability
// it declares (the rows the key popup shows), what each has stored, whether the identity key is kept, and
// switching one capability, picked path, approved device or kind of link it was chosen to open. The
// requests are data from a document, so each field is checked here, and a switch reaches the broker only
// through `./app-switches.ts` and the permissions controller.
import { originFromUrl } from '../../broker/policy/origin.js'
import { isCapabilityKind } from '../../broker/policy/request-grant.js'
import type { DeviceRows } from '../devices/hid-rows.js'
import type { RouteState } from '../route/route-hub.js'
import type { SchemeChoices } from '../scheme-routing/scheme-choices.js'
import type { InternalDomain } from '../pages/internal-ipc.js'
import type { PermissionsController } from './permissions.js'
import type { AppSwitches } from './app-switches.js'
import { orivonStorageFor } from './site-data-runner.js'

interface AppsRequest {
  readonly type?: unknown
  readonly origin?: unknown
  readonly capability?: unknown
  readonly on?: unknown
  readonly patterns?: unknown
  readonly pickId?: unknown
  readonly key?: unknown
  readonly scheme?: unknown
  readonly routed?: unknown
}

/** What an app's card needs to show and move the switch that sends its traffic through the person's proxy. */
export interface AppRoutes {
  /** What the app's route is doing: `off` for an app that is not routed. */
  readonly stateOf: (origin: string) => RouteState
  /** Whether the list of routed apps could not be read, so every app is routed (or stopped) until it is mended. */
  readonly unreadable: () => boolean
  /** Why the switch cannot be turned on now (it can always be turned off), or undefined when it can. */
  readonly blockedFor: (origin: string) => 'no-proxy' | 'not-cached' | undefined
  /** Resolves once the app's sessions follow the switch, so the card is not told it is on while they are still direct. */
  readonly set: (origin: string, routed: boolean) => Promise<void> | void
}

export interface AppsDeps {
  readonly permissions: Pick<PermissionsController, 'list' | 'revokePickedPath'>
  /** The capability rows of each app, and the switch that moves one. */
  readonly switches: AppSwitches
  readonly userDataPath: string
  /** The USB devices the person approved for each app (ADR-0068). */
  readonly devices: Pick<DeviceRows, 'rows' | 'forget'>
  /** The kinds of link each app was chosen to open (d-0596). */
  readonly links: Pick<SchemeChoices, 'schemesOf' | 'get' | 'forget'>
  readonly identity: () => Promise<'keychain' | 'session-only' | 'not-started'>
  /** The per-app network route (ADR-0080). */
  readonly routes: AppRoutes
}

/** The origin a request names, or null when it is not the canonical origin of an address. */
function originOf (value: unknown): string | null {
  return typeof value === 'string' && originFromUrl(value) === value ? value : null
}

/** The patterns a row offered, or null when the field is not a short list of strings. */
function patternsOf (value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.length <= MAX_PATTERNS && value.every((item) => typeof item === 'string') ? value as string[] : null
}

/** The most patterns a manifest may declare for one capability (`manifest.ts`), so a longer list is not a row Orivon drew. */
const MAX_PATTERNS = 256

export function appsDomain (deps: AppsDeps): InternalDomain {
  return {
    pages: ['settings'],
    handle: async (command) => {
      const request = (typeof command === 'object' && command !== null ? command : {}) as AppsRequest
      switch (request.type) {
        case 'list': {
          const apps = await deps.permissions.list()
          const withStorage = await Promise.all(apps.map(async ({ rows: _held, ...app }) => ({ ...app, capabilityRows: await deps.switches.rowsFor(app.origin), deviceRows: deps.devices.rows(app.origin), linkSchemes: deps.links.schemesOf(app.origin), route: { state: deps.routes.stateOf(app.origin), blocked: deps.routes.blockedFor(app.origin), unreadable: deps.routes.unreadable() }, storage: await orivonStorageFor(deps.userDataPath, app.origin, undefined, undefined) })))
          return { apps: withStorage, identity: await deps.identity() }
        }
        case 'setCapability': {
          const origin = originOf(request.origin)
          if (origin === null || typeof request.capability !== 'string' || !isCapabilityKind(request.capability) || typeof request.on !== 'boolean') return { ok: false }
          const shown = request.on ? patternsOf(request.patterns) : []
          if (shown === null) return { ok: false }
          const result = await deps.switches.set(origin, request.capability, request.on, shown)
          // 'stale': the manifest changed since the row was drawn, so the page draws it again before asking.
          return result === 'ok' ? { ok: true } : { ok: false, reason: result }
        }
        case 'revokePickedPath': {
          const origin = originOf(request.origin)
          if (origin === null || typeof request.pickId !== 'string' || request.pickId === '') return { ok: false }
          await deps.permissions.revokePickedPath(origin, request.pickId)
          return { ok: true }
        }
        case 'forgetDevice': {
          const origin = originOf(request.origin)
          if (origin === null || typeof request.key !== 'string' || request.key === '') return { ok: false }
          return { ok: deps.devices.forget(origin, request.key) }
        }
        case 'forgetLink': {
          const origin = originOf(request.origin)
          if (origin === null || typeof request.scheme !== 'string' || deps.links.get(request.scheme) !== origin) return { ok: false }
          return { ok: deps.links.forget(request.scheme) }
        }
        case 'setRoute': {
          const origin = originOf(request.origin)
          if (origin === null || typeof request.routed !== 'boolean') return { ok: false }
          // Turning a route on needs a proxy and an app held in the cache; turning it off never waits on either.
          if (request.routed && deps.routes.blockedFor(origin) !== undefined) return { ok: false }
          // A choice that could not be kept is reported, never shown as made.
          try {
            await deps.routes.set(origin, request.routed)
          } catch (error) {
            console.error('[apps] a route could not be switched:', error)
            return { ok: false }
          }
          return { ok: true }
        }
        default:
          return undefined
      }
    }
  }
}
