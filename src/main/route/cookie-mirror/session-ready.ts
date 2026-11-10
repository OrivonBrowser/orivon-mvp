// What a profile session waits for before its first request while the cookie mirror brings it in step with the default session: a
// page opened in a profile that is new to this run must not load without the cookies the person's normal browsing holds.

const merging = new WeakMap<object, Promise<void>>()

/** `merged` resolves (never rejects) when `session` holds what the default session does. */
export function holdForMerge (session: object, merged: Promise<void>): void {
  merging.set(session, merged)
}

/** The promise the session's first request waits for, or undefined when the mirror has nothing to wait for there. */
export function mergeOf (session: object): Promise<void> | undefined {
  return merging.get(session)
}
