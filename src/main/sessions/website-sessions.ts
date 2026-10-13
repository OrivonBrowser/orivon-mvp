// Every session a website runs in: the default one, and the session of its own a website gets when its tunnel state
// differs from the browser's default (`../route/site-partition.ts`). What must guard or adjust a website's requests
// installs through `forEachWebsiteSession`, so a website that moves into a session of its own keeps the privacy
// settings, the content blocks and the verifier's stamps it had in the shared one.
// Tied to Electron: the default session is Electron's.
import { session } from 'electron'
import type { Session } from 'electron'

const announced = new Set<Session>()
const listeners = new Set<(target: Session) => void>()

/** Calls `install` with the default session now, with every website session already announced, and with each new one as it is announced. */
export function forEachWebsiteSession (install: (target: Session) => void): void {
  listeners.add(install)
  install(session.defaultSession)
  for (const target of announced) install(target)
}

/**
 * A website session exists; every installer runs on it. Every installer runs even when one throws, and the failure is
 * rethrown at the end: a session that is missing a guard must not be used, so the caller refuses it.
 */
export function announceWebsiteSession (target: Session): void {
  if (announced.has(target)) return
  announced.add(target)
  const failures: unknown[] = []
  for (const install of [...listeners]) {
    try {
      install(target)
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'a website session could not be fitted with everything it needs')
}

/** The default session and every website session announced so far. */
export function websiteSessions (): Session[] {
  return [session.defaultSession, ...announced]
}
