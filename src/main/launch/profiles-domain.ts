// What the Profiles and Private pages, and Settings, may ask about profiles.
// A private session may look and may start another private session, and does
// not change the person's profiles: it holds none of their data.
import type { InternalDomain } from '../pages/internal-ipc.js'
import { PROFILE_COLORS } from './profile-store.js'
import type { ProfilesService } from './profiles-service.js'

interface ProfilesRequest {
  readonly type?: unknown
  readonly id?: unknown
  readonly name?: unknown
  readonly color?: unknown
}

export function profilesDomain (profiles: ProfilesService): InternalDomain {
  return {
    pages: ['profiles', 'private', 'settings'],
    handle: (command) => {
      const request = (typeof command === 'object' && command !== null ? command : {}) as ProfilesRequest
      const id = typeof request.id === 'string' ? request.id : ''
      const refusedInPrivate = { ok: false, reason: 'private' }
      switch (request.type) {
        case 'list':
          return { profiles: profiles.list(), colors: PROFILE_COLORS, isPrivate: profiles.isPrivate }
        case 'create':
          return profiles.isPrivate ? refusedInPrivate : profiles.create(request.name, request.color)
        case 'rename':
          return profiles.isPrivate ? refusedInPrivate : profiles.rename(id, request.name)
        case 'color':
          return profiles.isPrivate ? refusedInPrivate : profiles.setColor(id, request.color)
        case 'remove':
          return profiles.isPrivate ? refusedInPrivate : profiles.remove(id)
        case 'open':
          return { ok: profiles.open(id) }
        case 'newPrivate':
          profiles.openPrivate()
          return { ok: true }
        default:
          return undefined
      }
    }
  }
}
