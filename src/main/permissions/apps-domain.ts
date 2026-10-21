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
  readonly kind?: unknown
}

/** A tunnel an app can be sent through: Nym, or the person's proxy. */
export type AppTunnel = 'nym' | 'socks5'

/** What an app's card needs to show and move the choice of the tunnel its traffic goes through: the same choice the tunnel menu has. */
export interface AppRoutes {
  /** What the app's route is doing: `off` for an app that is not routed. */
  readonly stateOf: (origin: string) => RouteState
  /** The tunnel the app goes through now, or null when it goes through none. */
  readonly kindOf: (origin: string) => AppTunnel | null
  /** Whether the list of routed apps could not be read, so every app is routed (or stopped) until it is mended. */
  readonly unreadable: () => boolean
  /** Why the app cannot be sent through `kind` now (it can always be given up), or undefined when it can. */
  readonly blockedFor: (origin: string, kind: AppTunnel) => 'no-proxy' | 'not-cached' | 'nym-off' | undefined
  /** Resolves once the app's sessions follow the choice, so the card is not told it is made while they are still direct. */
  readonly set: (origin: string, kind: AppTunnel | null) => Promise<void> | void
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
  /** Called after a picked path was taken away, which the key counts: the chrome then asks main for the key again. */
  readonly changed?: () => void
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

/** Why each tunnel cannot be chosen for the app now, for the options of its card. */
function blockedKinds (routes: AppRoutes, origin: string): Partial<Record<AppTunnel, 'no-proxy' | 'not-cached' | 'nym-off'>> {
  const blocked: Partial<Record<AppTunnel, 'no-proxy' | 'not-cached' | 'nym-off'>> = {}
  for (const kind of ['nym', 'socks5'] as const) {
    const why = routes.blockedFor(origin, kind)
    if (why !== undefined) blocked[kind] = why
  }
  return blocked
}

export function appsDomain (deps: AppsDeps): InternalDomain {
  return {
    pages: ['settings'],
    handle: async (command) => {
      const request = (typeof command === 'object' && command !== null ? command : {}) as AppsRequest
      switch (request.type) {
        case 'list': {
          const listed = await deps.permissions.list()
          // An app that holds nothing and remembers a refusal is on the card list too, though the grant list leaves it out.
          const idle = await deps.switches.idleApps(new Set(listed.map((app) => app.origin)))
          const apps = [...listed, ...idle.map(({ origin, appName }) => ({ origin, appName, rows: [], pickedPathRows: [] }))]
          const withStorage = await Promise.all(apps.map(async ({ rows: _held, ...app }) => ({ ...app, capabilityRows: await deps.switches.rowsFor(app.origin), deviceRows: deps.devices.rows(app.origin), linkSchemes: deps.links.schemesOf(app.origin), route: { state: deps.routes.stateOf(app.origin), via: deps.routes.kindOf(app.origin), blocked: blockedKinds(deps.routes, app.origin), unreadable: deps.routes.unreadable() }, storage: await orivonStorageFor(deps.userDataPath, app.origin, undefined, undefined) })))
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
          deps.changed?.()
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
          const kind = request.kind
          if (origin === null || (kind !== null && kind !== 'nym' && kind !== 'socks5')) return { ok: false }
          // A tunnel needs an address (the proxy) or to be switched on (Nym), and an app held in the cache; giving one up never waits on either.
          if (kind !== null && deps.routes.blockedFor(origin, kind) !== undefined) return { ok: false }
          // A choice that could not be kept is reported, never shown as made.
          try {
            await deps.routes.set(origin, kind)
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
