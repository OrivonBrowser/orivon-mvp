// Which main-frame loads Orivon cancelled before sending them, and why, so the sheet over the tab can say so instead of
// naming an extension. Pure: no `electron` import.

/**
 * Why a load was cancelled: `onion`, its address is an onion address and the tab's session does not go through the person's
 * own SOCKS5 tunnel; `would-see`, its name is one the verifier serves and the session's proxy would carry it; `unsure`, the
 * session did not say which proxy it would use; `plain`, its name is one the verifier serves and it asked for plain http.
 */
export type LoadRefusal = 'onion' | 'would-see' | 'unsure' | 'plain'

/** What the sheet over a tab needs to tell a cancelled load from any other failed one. */
export interface LoadRefusals<Reason extends string = LoadRefusal> {
  /** Remembers that the main-frame load of `url` in the web contents `contentsId` was cancelled for `reason`; a request that belongs to no web contents is not remembered. */
  readonly note: (contentsId: number | undefined, url: string, reason: Reason) => void
  /** Why the load that failed at `url` in `contentsId` was cancelled, or undefined when it was not one of these; defined once per refusal. */
  readonly claims: (contentsId: number, url: string) => Reason | undefined
}

/** The newest refusal of each of at most `limit` web contents: a tab that is gone leaves one behind, and the oldest goes first. */
export function createLoadRefusals<Reason extends string = LoadRefusal> (limit = 64): LoadRefusals<Reason> {
  const refused = new Map<number, { readonly url: string, readonly reason: Reason }>()
  return {
    note (contentsId, url, reason) {
      if (contentsId === undefined) return
      refused.delete(contentsId)
      refused.set(contentsId, { url, reason })
      while (refused.size > limit) refused.delete(refused.keys().next().value as number)
    },
    claims (contentsId, url) {
      const found = refused.get(contentsId)
      if (found?.url !== url) return undefined
      refused.delete(contentsId)
      return found.reason
    }
  }
}

/** The refusals of this run, shared by the guards on every session and the sheet. */
export const loadRefusals: LoadRefusals = createLoadRefusals()
