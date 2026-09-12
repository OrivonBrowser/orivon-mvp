// Queue item 4.4's main-process half: the grant list, with revocation
// (d-0027, owner decision 9 -- a grant lasts until revoked, and is visible
// in a list the user can revoke from). Two renderer surfaces
// (src/renderer/permissions-view.ts, the settings panel; the toolbar's
// address-bar icon) both go through `PermissionsController` below, never
// the broker directly -- neither is a `broker` import away from the trust
// boundary this file already crossed once.
//
// REVOKE ONLY. There is no "forget this app entirely" here: that is
// `GrantLedger.forgetOrigin` (ADR-0009's 2026-09-04 amendment), which has no
// `Broker` interface method at all today (broker-contracts.ts's `Broker`
// lists `grant`/`revoke`, nothing that drops a manifest or a version floor)
// -- adding one is a `src/broker/` change, out of this lane's paths. Filing
// that gap rather than reaching past the boundary to build it.
//
// A SECOND, SEPARATE GAP THIS FILE WORKS AROUND: `Broker` has no way to
// enumerate registered origins (`app.manifest`/`app.grants` both take one
// origin already known to the caller). `PermissionsRegistry.noteOrigin` is
// the seam for whoever eventually learns of an origin becoming a real app
// -- nothing calls it yet, because nothing in production calls
// `broker.registerApp` yet either (`request-grant-subsystem.ts`'s own
// header: "NOTHING CALLS ctx.requestGrant YET"). Until one of the two ever
// happens, the settings page's full list is honestly empty; the address-bar
// icon does not depend on this registry at all -- `forOrigin` asks the
// broker about one already-known origin directly.

import type { CapabilityKind, Grant, GrantId, Manifest } from '../contracts/index.js'
import type { Broker } from '../broker/broker-contracts.js'
import { originFromUrl } from '../broker/policy/origin.js'
import { describeCapabilityGrant } from './grant-prompt-render.js'
import { isCapabilityKind } from '../broker/policy/request-grant.js'
import type { PersistedApp } from '../broker/grants/ledger-storage.js'
import type { SubsystemContext } from './registry.js'

/** One granted capability, rendered in the install prompt's own words
 * (`describeCapabilityGrant`) -- "same fact, same words" between the two
 * surfaces is the point, not a coincidence. */
export interface PermissionRow {
  readonly capability: CapabilityKind
  /** `null` for an app that is not loaded this session: its grants exist only
   * on disk, and a persisted grant has no live id. Revoke such a row through
   * `revokeCapability` instead, which addresses `(origin, capability)` --
   * unique, since an origin holds at most one grant per capability. */
  readonly grantId: GrantId | null
  readonly warning: boolean
  readonly message: string
}

/** One app's whole row set, for one card in the settings page or one
 * popover under the address bar. */
export interface AppPermissions {
  readonly origin: string
  readonly appName: string
  readonly rows: readonly PermissionRow[]
}

/** Pure: no broker, no I/O -- the mapping from what the ledger holds to
 * what a person reads, testable directly against real `Manifest`/`Grant`
 * values. */
export function buildAppPermissions (origin: string, manifest: Manifest, grants: readonly Grant[]): AppPermissions {
  const rows = grants.map((grant): PermissionRow => {
    const { warning, message } = describeCapabilityGrant(grant.capability, grant.patterns)
    return { capability: grant.capability, grantId: grant.id, warning, message }
  })
  return { origin, appName: manifest.name, rows }
}

/**
 * The same rows, for an app that has NOT been opened this session -- built
 * from what is on disk, with no manifest and no live grant involved (A137).
 *
 * The app's name is a plain string here rather than being read off a manifest,
 * and that is deliberate: there is no `Manifest` anywhere on this path, so
 * nothing on it can be mistaken for a declaration of what the app may do. An
 * origin with no saved name shows as its origin alone, which is honest and is
 * what a record written before the name was saved will do.
 */
export function buildPersistedAppPermissions (app: PersistedApp): AppPermissions {
  const rows: PermissionRow[] = []
  for (const [capability, grant] of Object.entries(app.grants)) {
    // UNTRUSTED disk content: a key here is not yet known to be one of the
    // seven real capability kinds, the same check hydration applies.
    if (!isCapabilityKind(capability)) continue
    const { warning, message } = describeCapabilityGrant(capability, grant.patterns)
    rows.push({ capability, grantId: null, warning, message })
  }
  return { origin: app.origin, appName: app.appName ?? app.origin, rows }
}

/**
 * Session-only registry of origins the settings page's full list knows
 * about -- see this file's own header for why it exists and why it starts
 * empty. `forOrigin` does not consult it: an address-bar icon already knows
 * which one origin it is asking about and asks the broker directly.
 */
export class PermissionsRegistry {
  readonly #origins = new Set<string>()

  /** The seam described above. Idempotent -- noting an origin twice is a no-op. */
  noteOrigin (origin: string): void {
    this.#origins.add(origin)
  }

  /** Every noted origin the broker still has a manifest for, each fetched
   * fresh (never cached) so a revoke made moments ago is already reflected.
   * An origin the broker no longer recognises (forgotten, or never really
   * registered) is dropped from the registry rather than shown as a broken
   * row -- there is nothing a person could do with a card for an app that
   * no longer exists. */
  async list (broker: Broker): Promise<readonly AppPermissions[]> {
    // THE BROKER IS THE SOURCE, not this set. `#origins` was once the only
    // input and `noteOrigin` never acquired a production caller, so the list
    // was empty for every grant made before the current session -- a person
    // granted an app four hosts, quit, and found Settings empty next launch
    // while the grant was still live (C-01/C-02).
    for (const origin of broker.app.registeredOriginsSync()) this.#origins.add(origin)

    const results: AppPermissions[] = []
    const loaded = new Set<string>()
    for (const origin of this.#origins) {
      // TWO DIFFERENT CONDITIONS, and conflating them used to lose an app
      // permanently (C-04, docs/open-questions.md). `describeOrigin` returns
      // null for BOTH "the broker has forgotten this origin" and "something
      // transiently failed while asking" -- and dropping the origin on the
      // second means one bad moment removes that app from the settings list
      // for the rest of the session, while its grants stay live. The
      // authoritative question is asked separately, of the one call that
      // cannot fail transiently: isRegisteredSync reads an in-memory map and
      // never throws or awaits.
      const app = await describeOrigin(broker, origin)
      if (app !== null) {
        results.push(app)
        loaded.add(origin)
      } else if (!broker.app.isRegisteredSync(origin)) {
        this.#origins.delete(origin)
      }
      // Registered but undescribable: keep it and try again next time. The
      // row is missing from THIS render, which is visible and recoverable --
      // unlike a silent delete, which is neither.
    }

    // Then the apps that exist only on disk -- installed, granted, and not
    // opened this session. Read for DISPLAY, never hydrated into the ledger:
    // these rows describe what is persisted, and a capability call is still
    // decided by the in-memory ledger alone (A137). An origin already rendered
    // above is skipped, so a loaded app is described from live state rather
    // than from whatever disk last recorded.
    for (const app of broker.app.persistedAppsSync()) {
      if (loaded.has(app.origin)) continue
      results.push(buildPersistedAppPermissions(app))
    }
    return results
  }

  /** For the address-bar icon: `origin` is asked about directly, with no
   * dependency on whether it was ever noted. `null` for anything the
   * broker does not recognise as registered -- an ordinary website, or an
   * app whose grants were all revoked and then forgotten. */
  async forOrigin (broker: Broker, origin: string): Promise<AppPermissions | null> {
    if (!broker.app.isRegisteredSync(origin)) return null
    return await describeOrigin(broker, origin)
  }
}

/** Shared by `list`/`forOrigin` -- one manifest+grants fetch, one failure
 * mode (drop the row rather than throw into a renderer that cannot recover
 * from it). */
async function describeOrigin (broker: Broker, origin: string): Promise<AppPermissions | null> {
  try {
    const [manifest, grants] = await Promise.all([broker.app.manifest(origin), broker.app.grants(origin)])
    return buildAppPermissions(origin, manifest, grants)
  } catch {
    return null
  }
}

/** What both renderer surfaces actually call, over IPC (`./ipc.ts`) --
 * broker-shaped but broker-free at the call site, so a page (or a test)
 * never has to know whether `ctx.broker` happens to be published yet. */
export interface PermissionsController {
  list: () => Promise<readonly AppPermissions[]>
  /** Derives the origin from a tab's own URL -- the same
   * `originFromUrl`/`isRegisteredSync` pairing `tab-view.ts`'s
   * `appTabArgsFor` already uses for the identical question, asked here for
   * the toolbar's address-bar icon instead of a fetch-routing flag. */
  forUrl: (url: string) => Promise<AppPermissions | null>
  /** REVOKES ONE CAPABILITY, never the whole app -- see this file's header. */
  revoke: (origin: string, grantId: GrantId) => Promise<void>
  /** REVOKES ONE CAPABILITY from an app that may not be loaded, addressed by
   * `(origin, capability)` because a persisted grant has no live id. */
  revokeCapability: (origin: string, capability: CapabilityKind) => Promise<void>
}

/** The one way to build a `PermissionsController`, closing over `ctx`
 * (never a captured `Broker`) so it always reads whichever broker is
 * currently published -- `ctx.broker` is a live getter (registry.ts), and
 * this must see the same instance every other subsystem does. */
export function createPermissionsController (ctx: SubsystemContext): PermissionsController {
  const registry = new PermissionsRegistry()
  return {
    async list () {
      const broker = ctx.broker
      return broker === undefined ? [] : await registry.list(broker)
    },
    async forUrl (url) {
      const broker = ctx.broker
      if (broker === undefined) return null
      const origin = originFromUrl(url)
      if (origin === null) return null
      return await registry.forOrigin(broker, origin)
    },
    async revoke (origin, grantId) {
      const broker = ctx.broker
      if (broker === undefined) return
      await broker.revoke(origin, grantId)
    },

    /** The persisted-app path: `(origin, capability)` rather than an id. Goes
     * to the broker's own `revokePersisted`, which also drops the capability in
     * memory when the app IS loaded, so disk and ledger cannot disagree. */
    async revokeCapability (origin, capability) {
      const broker = ctx.broker
      if (broker === undefined) return
      await broker.revokePersisted(origin, capability)
    }
  }
}
