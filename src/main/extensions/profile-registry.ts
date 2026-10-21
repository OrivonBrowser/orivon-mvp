// The profile sessions the person's extensions run in besides the default one: for each, its partition name, what keeps
// count of the websites open in it (`profile-demand.ts`) and the extensions loaded in it (`profile-extensions.ts`). Read by the
// extension host to put a tab with the library instance of its own session. Tied to Electron: it keys on a session.
import type { Session } from 'electron'
import type { ProfileDemand } from './profile-demand.js'
import type { ProfileExtensions } from './profile-extensions.js'

export interface ProfileEntry {
  readonly session: Session
  /** The session's name (`persist:tunnel-profile`), which the toolbar's list is addressed by. */
  readonly partition: string
  readonly demand: ProfileDemand
  readonly extensions: ProfileExtensions
}

const entries = new Map<Session, ProfileEntry>()

export function registerProfile (entry: ProfileEntry): void {
  entries.set(entry.session, entry)
}

export function profileEntryOf (session: Session): ProfileEntry | undefined {
  return entries.get(session)
}

export function profileEntries (): readonly ProfileEntry[] {
  return [...entries.values()]
}

/**
 * The session name a page of an extension that `session`'s library instance opens must run in: the profile's own, so that the
 * page talks to the copy of the extension in that session. Nothing for an address that is not an extension page, and for the
 * default session, where a tab with no name is the right one.
 */
export function extensionPagePartition (session: Session, target: string | undefined): string | undefined {
  return target?.startsWith('chrome-extension://') === true ? entries.get(session)?.partition : undefined
}
