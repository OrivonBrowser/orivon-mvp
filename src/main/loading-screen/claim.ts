// Who else speaks on a tab's cover. A first visit to an app (../app-setup/) words its own screen in the
// cover slot, and the protocol's screen for the same address must not replace it.
const claims = new WeakMap<object, number>()

/** Takes the tab's cover until the returned release is called, which is safe to call twice. Claims nest. */
export function claimCover (contents: object): () => void {
  claims.set(contents, (claims.get(contents) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const left = (claims.get(contents) ?? 1) - 1
    if (left <= 0) claims.delete(contents)
    else claims.set(contents, left)
  }
}

export function isCoverClaimed (contents: object): boolean {
  return claims.has(contents)
}
