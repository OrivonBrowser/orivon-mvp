// How "Clear browsing data" reaches the cookie mirror without importing it: whoever runs the mirror registers the way to make it
// forget the sites it has copied, and the privacy domain calls it. Pure.

let current: (() => Promise<void>) | undefined

/** Called once at start by whoever runs the mirror. */
export function setCookieMirrorForgetter (next: (() => Promise<void>) | undefined): void {
  current = next
}

/** Makes the mirror forget every site it has copied into a profile, clearing the copies; nothing to do where no mirror runs. */
export async function forgetMirroredSites (): Promise<void> {
  await current?.()
}
