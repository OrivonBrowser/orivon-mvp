// Every session a website runs in: the default one, and the session of its own a website gets when its tunnel state
// differs from the browser's default (`../route/site-partition.ts`). What must guard or adjust a website's requests
// installs through `forEachWebsiteSession`, so a website that moves into a session of its own keeps the privacy
// settings, the content blocks and the verifier's stamps it had in the shared one.
// Tied to Electron: the default session is Electron's.
import { session } from 'electron'
import type { Session } from 'electron'

const announced = new Set<Session>()
/** A session an installer failed on stays refused: running the installers again would put some of them on it twice. */
const failed = new Map<Session, AggregateError>()
/** The sessions that belong to a tunnel profile (Nym's or the proxy's): what the verifier is told of the requests made in them. */
const tunnelProfiles = new WeakSet<Session>()
/** `tunnelProfile` is true for the session every website whose entry is a tunnel shares: one for each tunnel. */
type Installer = (target: Session, tunnelProfile: boolean) => void
const listeners = new Set<Installer>()

/** Calls `install` with the default session now, with every website session already announced, and with each new one as it is announced. */
export function forEachWebsiteSession (install: Installer): void {
  listeners.add(install)
  install(session.defaultSession, false)
  for (const target of announced) install(target, tunnelProfiles.has(target))
}

/**
 * A website session exists; every installer runs on it. Every installer runs even when one throws, and the failure is
 * rethrown at the end: a session that is missing a guard must not be used, so the caller refuses it.
 */
export function announceWebsiteSession (target: Session, tunnelProfile = false): void {
  const earlier = failed.get(target)
  if (earlier !== undefined) throw earlier
  if (announced.has(target)) return
  announced.add(target)
  if (tunnelProfile) tunnelProfiles.add(target)
  const failures: unknown[] = []
  for (const install of [...listeners]) {
    try {
      install(target, tunnelProfile)
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) {
    const error = new AggregateError(failures, 'a website session could not be fitted with everything it needs')
    failed.set(target, error)
    throw error
  }
}

/** The default session and every website session announced so far. */
export function websiteSessions (): Session[] {
  return [session.defaultSession, ...announced]
}
