// `orivon.web`'s own vocabulary -- pure type declarations, split out of
// ./broker-contracts.ts (code-guidelines.md Rule 2) once ADR-0019 pushed
// that file past 500 lines. Concern-based, matching ./fs-contracts.ts's own
// precedent (the split here is by SUBSYSTEM, one file per capability's own
// broker-internal shapes). Re-exported from broker-contracts.ts, so no
// import site elsewhere needed to change.

/**
 * ADR-0019's `web.context` escape hatch into Electron -- the ONLY piece of
 * this capability the broker itself cannot do, because opening a real
 * `WebContentsView` needs `electron` (./web-capability.ts's own header: "the
 * broker stays Electron-free"). `src/main/web-context-host.ts` is the real
 * implementation, wired in where the shell builds the broker
 * (`CreateBrokerOptions.webContextHost`); a fake stands in for it in every
 * broker-level unit test.
 *
 * ID-ADDRESSED, not object-addressed, on purpose: `open` mints and returns
 * its OWN id (never one the caller supplies), and `evaluate`/`close` are
 * addressed by that same id -- the broker's own `web-capability.ts` holds no
 * live reference to whatever object represents the real context, only this
 * id, alongside the `HandleTable` entry id ADR-0019's own security
 * properties (revocation, the per-origin budget) are enforced against.
 */
export interface WebContextHost {
  /** Opens an isolated context at `origin`, for `opener`'s own partition-slot
   * budget -- resolves the HOST'S OWN id for it, never a caller-supplied one. */
  open (opener: string, origin: string, size: { width: number, height: number }): Promise<string>
  /** Runs `script` as a classic script in the context `id` names, resolving with its completion value. */
  evaluate (id: string, script: string): Promise<unknown>
  /** Idempotent, matching `Handle.close()`'s own contract -- closing an id already closed is a no-op. */
  close (id: string): Promise<void>
}

/**
 * `Broker['web']` -- ADR-0019, `orivon.web.openContext`/`WebContext.
 * evaluate`/`.close`'s broker-internal counterpart, ID-ADDRESSED throughout
 * (see `WebContextHost`'s own doc), unlike `net`'s handle-object-returning
 * methods: `openContext` resolves a plain `{id, origin}` descriptor, never a
 * live object with bound methods, because the injected host is already
 * id-addressed and there is nothing else for a broker-side object to hold.
 * `id` is the SAME opaque id `HandleTable.acquire` mints -- per-origin,
 * unforgeable across origins (T11c), exactly like every other handle.
 */
export interface BrokerWebMethods {
  /** Rejects 'invalid' unless `opts.origin` is an exact https origin; 'denied' unless a live `web.context` grant names it exactly (never saying which of the two failed); 'limit' past `LIMITS.webContexts` open at once; 'internal' if no `WebContextHost` is wired in. */
  openContext(origin: string, opts: { origin: string, width?: number, height?: number }): Promise<{ id: string, origin: string }>
  /** Rejects 'denied' if `opts.id` is not a live context this origin holds; 'timeout' after `LIMITS.webContextEvaluateMs`; 'limit' if the script or result exceeds its byte cap, or another evaluate on this context is already running; 'revoked' if the grant is withdrawn meanwhile. */
  evaluate(origin: string, opts: { id: string, script: string }): Promise<unknown>
  /** Idempotent, matching `Handle.close()` -- closing an id this origin does not hold is a silent no-op. */
  close(origin: string, opts: { id: string }): Promise<void>
  /**
   * Resolves once `opts.id` actually leaves the broker's tables -- a clean
   * close resolves, a revoke or the idle timer's own close settles the same
   * way `HandleEntry.closed` itself would. NOT part of ADR-0019's three
   * named control methods; added because `contracts/handles.ts`'s
   * `WebContext.closed` promises the same LIVE behaviour every other
   * Handle's `closed` has, and `orivon.web` carries no port channel of its
   * own for the broker to push that notification through unprompted
   * (../../preload/web-surface.ts's own header explains the polling loop
   * this drives). Rejects 'denied'/'closed' immediately for an id this
   * origin does not currently hold, matching every other handle-scoped
   * method's own ownership check (T11c).
   */
  awaitClose(origin: string, opts: { id: string }): Promise<void>
}
