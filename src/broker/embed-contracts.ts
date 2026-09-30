// `web.embed`'s broker-internal vocabulary (ADR-0039) -- pure type
// declarations, split out of ./broker-contracts.ts the way
// ./web-context-contracts.ts is, and re-exported from there.

import type { Pattern } from '../contracts/index.js'

/**
 * `Broker['embed']`. The shell's embed host (src/main/embed/) is the only
 * caller of the synchronous or trusted-side members; `setScript` is
 * `orivon.web.setEmbedScript`'s broker half, reached over CONTROL_CHANNEL
 * like every other capability call.
 *
 * THREE MEMBERS ARE SYNCHRONOUS on purpose, the same reason `Broker.app.
 * hasGrantsSync` is: Electron decides whether a `<webview>` may attach
 * inside a synchronous event (`will-attach-webview`, where `preventDefault`
 * must run before the handler returns), and a shown page's preload asks for
 * its script over a synchronous channel so the script runs before the page's
 * own code. All three read in-memory state and never throw; an origin that
 * does not parse is simply "not granted".
 */
export interface BrokerEmbedMethods {
  /** The live `web.embed` grant's patterns for `origin`, or undefined with none. */
  originsSync(origin: string): readonly Pattern[] | undefined
  /**
   * Whether `origin` itself holds a TCP listener on `port`, from any scope
   * and any grant (ADR-0047's local pattern reaches only such a port).
   * Synchronous for the same reason as `originsSync`, and false for an
   * origin that does not parse.
   */
  holdsListenerSync(origin: string, port: number): boolean
  /**
   * Calls `listener(origin, port)` when `origin`'s last listener on `port`
   * closes, by any path (its own close, a revoked or narrowed grant, a
   * failure), so the shell can close a page it still shows from that port
   * (ADR-0047). Returns the unsubscribe.
   */
  onListenerClosed(listener: (origin: string, port: number) => void): () => void
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
  /**
   * Drops whatever `setScript` stored for `key`, without touching the
   * grant -- `../index.ts`'s `revoke`/`revokePersisted` call this once
   * `web.embed` no longer has ANY live grant for the origin, the same
   * way they already cascade to `HandleTable.revoke` for the pages the
   * grant authorised. Without it the script string outlived the grant that
   * justified storing it, sitting in this process's memory for as long as
   * the browser runs. `key` is ALREADY CANONICAL (the caller's own `key`,
   * not a raw `origin`) -- unlike `originsSync`/`scriptSync`, this is never
   * reached from an untrusted call site, only from the revoke cascade,
   * which has already done that work.
   */
  forgetScript(key: string): void
}
