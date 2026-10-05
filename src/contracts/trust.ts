// Transcribed from docs/architecture/capability-api.md's "v0 surface" section.
//
// trust.ts - Asking the person's Web3 Score provider about other sites (ADR-0058)
//
// Held in its own file so capability-api.ts stays under the source-size
// limit; `Orivon.trust` there is the only member that points here.

/**
 * `orivon.trust`: what the Web3 Score provider the person chose in Settings
 * says about a site. Needs the `trust.score` grant; ungranted, the call
 * rejects `'denied'`.
 */
export interface OrivonTrust {
  /**
   * The provider's judged Website level for the content `address` names.
   *
   * `address` is what a page would open: `ipfs://<cid>[/...]`,
   * `https://<name>.eth[/...]`, or a bare `<name>.eth`. A `.eth` name is
   * resolved to its content first, which a cold light client can take
   * seconds to tens of seconds to do.
   *
   * Never rejects because the provider could not help: no provider chosen,
   * an address that names no content, no evaluation, a provider that is
   * down or slow, and a name that did not resolve all resolve with
   * `level: null`. Rejects `'denied'` with no live `trust.score` grant,
   * `'invalid'` for a value that is not a string, and `'limit'` past the
   * rate the broker allows one origin.
   */
  websiteScore(address: string): Promise<WebsiteScore>
}

export interface WebsiteScore {
  /**
   * The chosen provider's own name from its `provider.json`, or its address
   * when that file could not be read; `null` when the person chose none.
   * Naming the provider is a fingerprint of the person's setting, which is
   * why the call needs a grant.
   */
  readonly provider: string | null
  /**
   * The provider's raw judged level for that content, 1 to 4. The shield's
   * display rule (what Orivon shows for a given level) is the page's to
   * apply; it is not applied here. `null`: no evaluation, no answer, or an
   * address that does not name content.
   */
  readonly level: 1 | 2 | 3 | 4 | null
}
