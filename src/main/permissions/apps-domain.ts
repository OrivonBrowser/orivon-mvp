// What the Settings page may ask about the apps that hold permissions: the same
// list the toolbar's all-sites panel shows, what each has stored, whether the
// identity key is kept, and revoking one permission or one picked path. The
// requests are data from a document, so each field is checked here, and a
// revoke reaches the broker only through the permissions controller.
import { originFromUrl } from '../../broker/policy/origin.js'
import { isCapabilityKind } from '../../broker/policy/request-grant.js'
import type { InternalDomain } from '../pages/internal-ipc.js'
import type { PermissionsController } from './permissions.js'
import { orivonStorageFor } from './site-data-runner.js'

interface AppsRequest {
  readonly type?: unknown
  readonly origin?: unknown
  readonly capability?: unknown
  readonly pickId?: unknown
}

export interface AppsDeps {
  readonly permissions: Pick<PermissionsController, 'list' | 'revokeCapability' | 'revokePickedPath'>
  readonly userDataPath: string
  readonly identity: () => Promise<'keychain' | 'session-only' | 'not-started'>
}

/** The origin a request names, or null when it is not the canonical origin of an address. */
function originOf (value: unknown): string | null {
  return typeof value === 'string' && originFromUrl(value) === value ? value : null
}

export function appsDomain (deps: AppsDeps): InternalDomain {
  return {
    pages: ['settings'],
    handle: async (command) => {
      const request = (typeof command === 'object' && command !== null ? command : {}) as AppsRequest
      switch (request.type) {
        case 'list': {
          const apps = await deps.permissions.list()
          const withStorage = await Promise.all(apps.map(async (app) => ({ ...app, storage: await orivonStorageFor(deps.userDataPath, app.origin, undefined, undefined) })))
          return { apps: withStorage, identity: await deps.identity() }
        }
        case 'revoke': {
          const origin = originOf(request.origin)
          if (origin === null || typeof request.capability !== 'string' || !isCapabilityKind(request.capability)) return { ok: false }
          await deps.permissions.revokeCapability(origin, request.capability)
          return { ok: true }
        }
        case 'revokePickedPath': {
          const origin = originOf(request.origin)
          if (origin === null || typeof request.pickId !== 'string' || request.pickId === '') return { ok: false }
          await deps.permissions.revokePickedPath(origin, request.pickId)
          return { ok: true }
        }
        default:
          return undefined
      }
    }
  }
}
