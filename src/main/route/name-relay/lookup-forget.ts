// How "Clear browsing data" reaches the name relay's lookups without importing them: whoever runs the lookups registers the way to
// make them forget every answer, and the privacy domain calls it. The cache is shared by every relayed session, so a name stays
// timeable (a lookup that answers at once is one asked for lately) until it is forgotten. Pure.

let current: (() => void) | undefined

/** Called once at start by whoever runs the lookups. */
export function setNameLookupForgetter (next: (() => void) | undefined): void {
  current = next
}

/** Makes the relay's lookups forget every answer; nothing to do where none run. */
export function forgetNameLookups (): void {
  current?.()
}
