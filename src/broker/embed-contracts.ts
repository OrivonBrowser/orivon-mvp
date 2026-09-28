// `web.embed`'s broker-internal vocabulary (ADR-0039) -- pure type
// declarations, split out of ./broker-contracts.ts the way
// ./web-context-contracts.ts is, and re-exported from there.

import type { Pattern } from '../contracts/index.js'

/**
 * `Broker['embed']`. The shell's embed host (src/main/embed/) is the only
 * caller of the three synchronous or trusted-side members; `setScript` is
 * `orivon.web.setEmbedScript`'s broker half, reached over CONTROL_CHANNEL
 * like every other capability call.
 *
 * TWO MEMBERS ARE SYNCHRONOUS on purpose, the same reason `Broker.app.
 * hasGrantsSync` is: Electron decides whether a `<webview>` may attach
 * inside a synchronous event (`will-attach-webview`, where `preventDefault`
 * must run before the handler returns), and a shown page's preload asks for
 * its script over a synchronous channel so the script runs before the page's
 * own code. Both read the in-memory ledger and never throw; an origin that
 * does not parse is simply "not granted".
 */
export interface BrokerEmbedMethods {
  /** The live `web.embed` grant's patterns for `origin`, or undefined with none. */
  originsSync(origin: string): readonly Pattern[] | undefined
  /** The script `setScript` stored for `origin`, or undefined with none set or no live grant. */
  scriptSync(origin: string): string | undefined
  /**
   * Registers one page `origin` is about to show, under its live grant, so
   * revoking the grant tears the page down through `HandleTable.revoke`'s
   * ordinary cascade -- the same mechanism a socket or an isolated context
   * answers to, not a second one. `destroy` is what closes the page.
   * Throws 'denied' with no live grant and 'limit' past `LIMITS.embeds`;
   * a refused registration has already called `destroy`.
   *
   * `release` is for the page going away on its own (closed by the app,
   * or its renderer gone): idempotent, and closes the registration through
   * the table's ordinary path, whose close runs `destroy` once more -- a
   * no-op for a page already gone, and the reason `destroy` must tolerate
   * one.
   */
  attach(origin: string, destroy: () => void): { readonly release: () => void }
  /**
   * `orivon.web.setEmbedScript`: stores `source` as the script that runs
   * first in every page `origin` shows from now on. Rejects 'denied' with
   * no live `web.embed` grant, 'invalid' unless `source` is a string,
   * 'limit' past `LIMITS.embedScriptBytes`. The empty string clears it.
   */
  setScript(origin: string, opts: { source: string }): Promise<void>
}
