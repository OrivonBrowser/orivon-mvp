// What the cookie mirror is doing, as a handful of counts and one word: the one place `orivon://report` reads it from. No cookie
// name, value or site is ever part of it. Pure.

export interface CookieMirrorStatus {
  /** `mirroring`: the profiles' cookies and the default session's are kept in step. `separate`: they are apart (the setting's default). */
  readonly state: 'separate' | 'mirroring'
  /** How many profile sessions are in step with the default one. */
  readonly sessions: number
  /** Cookies written into a session, cookies removed from one, writes that failed (a clear that failed counts as one), and writes held back because one cookie kept changing. */
  readonly copied: number
  readonly removed: number
  readonly failed: number
  readonly suppressed: number
}

const SEPARATE: CookieMirrorStatus = { state: 'separate', sessions: 0, copied: 0, removed: 0, failed: 0, suppressed: 0 }

let current: (() => CookieMirrorStatus) | undefined

/** Called once at start by whoever runs the mirror. */
export function setCookieMirrorStatusSource (next: (() => CookieMirrorStatus) | undefined): void {
  current = next
}

export function cookieMirrorStatus (): CookieMirrorStatus {
  return current?.() ?? SEPARATE
}
