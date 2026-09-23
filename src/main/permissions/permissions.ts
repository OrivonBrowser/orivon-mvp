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
// A GAP `PermissionsRegistry.noteOrigin` WAS ONCE WORKING AROUND, NOW CLOSED
// A DIFFERENT WAY: `noteOrigin` still has no production caller anywhere in
// this tree, but `list()` below no longer depends on one having ever fired.
// It sources the settings page's full list straight from
// `broker.app.registeredOriginsSync()` and `persistedAppsSync()`, so an
// origin installed without ever calling `noteOrigin` is still shown. The
// address-bar icon never depended on this registry either way: `forOrigin`
// asks the broker about one already-known origin directly, so the surface a
// person actually revokes from was never affected.

import type { CapabilityKind, Grant, GrantId, Manifest } from '../../contracts/index.js'
import type { Broker, PickedPath } from '../../broker/broker-contracts.js'
import { originFromUrl } from '../../broker/policy/origin.js'
import { describeCapabilityGrant } from '../consent/grant-prompt-render.js'
import { isCapabilityKind } from '../../broker/policy/request-grant.js'
import { UNSAFE_TEXT_CHARS } from '../../loader/manifest.js'
import type { PersistedApp, PersistedPick } from '../../broker/grants/ledger-storage.js'
import type { SubsystemContext } from '../registry.js'
import type { NotificationDecision } from '../sessions/notification-decisions.js'

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

/**
 * One `orivon.fs.userSelected` pick, rendered the same "same fact, same
 * words" way `PermissionRow` is -- D-0007's own instruction that a picked
 * path sits "beside that app's network and file access" in this list, not
 * off in a second surface.
 *
 * WORDING SETTLED (owner decision `d-0032`, 2026-09-16, queue item 4.3).
 * `describePickedPath` below is where it is generated.
 */
export interface PickedPathRow {
  readonly pickId: string
  readonly warning: boolean
  readonly message: string
}

/** One app's whole row set, for one card in the settings page or one
 * popover under the address bar. */
export interface AppPermissions {
  readonly origin: string
  readonly appName: string
  readonly rows: readonly PermissionRow[]
  readonly pickedPathRows: readonly PickedPathRow[]
}

/**
 * The words a person reads for one picked path -- kept apart from
 * `describeCapabilityGrant` (a `CapabilityKind` concept a pick is not) but
 * following its own "visual contrast, not accuracy alone" rule
 * (grant-prompt-render.ts's header): `warning: true` for a folder pick,
 * because it grants a WHOLE SUBTREE and that breadth must be visible
 * exactly as an unlimited network pattern's warning already is -- this
 * lane's own brief, echoing the owner's standing instruction. A single
 * picked FILE is narrow by construction and does not carry it.
 *
 * FOLDER WORDING IS OWNER-APPROVED VERBATIM (`d-0032`, 2026-09-16): the
 * owner chose the strongest of three drafted options, on the reasoning that
 * "read and write" understated what a folder grant really lets an app do --
 * the phrase "including new files" is load-bearing and must not be trimmed
 * (this is the exact thing people misread about a folder pick: they picture
 * only what is visible today, not a standing grant over everything the
 * folder will ever hold). The FILE wording follows the same voice but is
 * DERIVED, not separately owner-reviewed word for word: a `FileHandle` has
 * no delete/unlink method (handles.ts's own method set), so it says what it
 * actually permits -- read and change the file's own bytes, including
 * emptying it via `truncate(0)` -- rather than claiming a "delete" this
 * handle cannot do.
 */
export function describePickedPath (kind: PersistedPick['kind'], path: string): { warning: boolean, message: string } {
  return kind === 'directory'
    ? { warning: true, message: `Can read, change and delete everything in "${path}", including new files.` }
    : { warning: false, message: `Can read and change "${path}", including emptying it.` }
}

/** Pure: no broker, no I/O -- the mapping from what the ledger holds to
 * what a person reads, testable directly against real `Manifest`/`Grant`
 * values. `pickedPaths` defaults to empty so every existing call site (none
 * of which knew about picks before this lane) keeps compiling unchanged. */
export function buildAppPermissions (origin: string, manifest: Manifest, grants: readonly Grant[], pickedPaths: readonly PickedPath[] = []): AppPermissions {
  const rows = grants.map((grant): PermissionRow => {
    const { warning, message } = describeCapabilityGrant(grant.capability, grant.patterns)
    return { capability: grant.capability, grantId: grant.id, warning, message }
  })
  const pickedPathRows = pickedPaths.map((pick): PickedPathRow => {
    const { warning, message } = describePickedPath(pick.kind, pick.path)
    return { pickId: pick.id, warning, message }
  })
  return { origin, appName: manifest.name, rows, pickedPathRows }
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
  const pickedPathRows: PickedPathRow[] = []
  for (const [pickId, pick] of Object.entries(app.pickedPaths)) {
    const { warning, message } = describePickedPath(pick.kind, pick.path)
    pickedPathRows.push({ pickId, warning, message })
  }
  return { origin: app.origin, appName: displayableName(app.appName) ?? app.origin, rows, pickedPathRows }
}

/**
 * The saved name, or `undefined` if it is not safe to render.
 *
 * `manifest.ts` enforces a length bound and rejects control codes, bidi
 * overrides and zero-width characters on `name` AT PARSE TIME, precisely
 * because a bidi override renders as a spoof. So a name that reached disk
 * normally has already passed that check -- but a hand-edited or corrupted
 * `grants.json` has not, and that is a file this feature's own design treats
 * as in scope. `readPersistedApp` only checks that the field is a string.
 *
 * Re-checked here rather than in the broker's storage layer for two reasons:
 * `src/broker/` imports nothing from `src/loader/` today and this is not worth
 * inverting that, and display safety is the display layer's own concern -- the
 * storage layer's job is the shape. Failing it falls back to showing the
 * origin, exactly as a missing name does, so the row stays useful.
 */
function displayableName (name: string | undefined): string | undefined {
  if (name === undefined) return undefined
  if (name.length === 0 || name.length > MAX_DISPLAYED_NAME_LENGTH) return undefined
  if (UNSAFE_TEXT_CHARS.test(name)) return undefined
  return name
}

/**
 * One site's remembered answer to "may this site show notifications?". A
 * Chromium permission, not an `orivon.*` grant, so it is its own list, one
 * row per site, app or not. Resetting forgets the answer: the site asks
 * again next time, rather than being blocked.
 */
export interface SiteNotificationRow {
  readonly origin: string
  readonly allowed: boolean
  readonly message: string
}

/** The store `../sessions/notification-decisions.ts` keeps, as this list reads it. */
export interface SiteNotificationSource {
  entries: () => ReadonlyArray<{ origin: string, decision: NotificationDecision }>
  forget: (origin: string) => void
}

export function describeSiteNotifications (entries: ReadonlyArray<{ origin: string, decision: NotificationDecision }>): SiteNotificationRow[] {
  return [...entries]
    .sort((a, b) => a.origin.localeCompare(b.origin))
    .map(({ origin, decision }) => decision === 'allow'
      ? { origin, allowed: true, message: 'Can show notifications.' }
      : { origin, allowed: false, message: 'Blocked from showing notifications.' })
}

/** What the permissions panel calls for the site list, over IPC. Kept apart
 * from `PermissionsController`: these rows never touch the broker. */
export interface SiteNotificationsController {
  list: () => readonly SiteNotificationRow[]
  /** Forgets one site's answer; it is asked again on its next request. */
  reset: (origin: string) => void
}

export function createSiteNotificationsController (sites: SiteNotificationSource): SiteNotificationsController {
  return {
    list: () => describeSiteNotifications(sites.entries()),
    reset: (origin) => { sites.forget(origin) }
  }
}

/** Matches `manifest.ts`'s own MAX_NAME_LENGTH. Not imported because that constant is private to it; kept equal deliberately, and the test asserts the boundary. */
const MAX_DISPLAYED_NAME_LENGTH = 200

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
      const described = buildPersistedAppPermissions(app)
      // An app whose last capability was revoked leaves an empty record behind
      // (`revoke` does not delete the file when the set empties). Showing that
      // as a card with no rows and no revoke button would be a permanent piece
      // of furniture a person cannot act on or dismiss -- so a persisted app
      // with nothing left to revoke is not listed. BOTH row kinds count: an
      // app with grants all revoked but a picked path still live is exactly
      // as actionable as one the other way around. A LOADED app with zero of
      // either still is, above, because it is genuinely installed and running.
      if (described.rows.length === 0 && described.pickedPathRows.length === 0) continue
      results.push(described)
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
    const [manifest, grants, pickedPaths] = await Promise.all([broker.app.manifest(origin), broker.app.grants(origin), broker.app.pickedPaths(origin)])
    return buildAppPermissions(origin, manifest, grants, pickedPaths)
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
  /**
   * REVOKES ONE PICKED PATH, addressed by `pickId` rather than a
   * `CapabilityKind` -- a pick holds no standing grant, so `revokeCapability`
   * cannot address it (this file's own header on `PermissionRow.grantId`
   * explains the same split one level up). Works whether or not the owning
   * app is loaded this session -- `Broker.revokeUserSelectedPath`'s own doc.
   */
  revokePickedPath: (origin: string, pickId: string) => Promise<void>
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
    },

    async revokePickedPath (origin, pickId) {
      const broker = ctx.broker
      if (broker === undefined) return
      await broker.revokeUserSelectedPath(origin, pickId)
    }
  }
}
