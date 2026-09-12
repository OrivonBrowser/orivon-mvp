import type { AppPermissions, PermissionRow } from '../../main/permissions.js'
import type { CapabilityKind, GrantId } from '../../contracts/index.js'
import { createPermissionsListView } from './permissions-view.js'

// The settings window's whole job: fetch the list, render it, revoke on
// click, re-fetch. No live push channel exists for this yet (unlike the
// chrome view's ShellState) -- every render is a fresh `list()` round trip,
// which is cheap enough at the scale this page ever shows (a handful of
// apps) and keeps this file simple. See src/main/settings-window.ts's own
// header for the one known gap this causes: re-opening an already-open
// window for a different `focusOrigin` does not re-scroll it.

interface OrivonSettings {
  list: () => Promise<readonly AppPermissions[]>
  revoke: (origin: string, grantId: GrantId) => Promise<void>
  /** For a row whose app is not loaded this session -- see revokeAndRefresh. */
  revokeCapability: (origin: string, capability: CapabilityKind) => Promise<void>
  focusOrigin: string | null
}

declare global {
  interface Window {
    orivonSettings?: OrivonSettings
  }
}

function must<T> (value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message)
  return value
}

// A hard throw, unlike newtab.ts's graceful degrade: this window's preload
// path is fixed at construction (settings-window.ts) and never anything
// but preload/settings.ts, so `orivonSettings` missing here means the
// preload itself failed, not a legitimately unprivileged load.
const settings = must(window.orivonSettings, 'orivonSettings not exposed -- preload did not run')

const list = must(document.querySelector<HTMLDivElement>('#apps-list'), '#apps-list missing')
const emptyState = must(document.querySelector<HTMLElement>('#empty-state'), '#empty-state missing')

const view = createPermissionsListView(list, emptyState, (origin, row) => {
  void revokeAndRefresh(origin, row)
})

/** Scrolls to `settings.focusOrigin`'s card once, the first time it
 * appears in a rendered list -- guarded so a later refresh (after a
 * revoke) never yanks the page back to it a second time. */
let scrolledToFocusOrigin = false
function scrollToFocusOriginOnce (): void {
  if (scrolledToFocusOrigin || settings.focusOrigin === null) return
  const card = list.querySelector<HTMLElement>(`[data-origin="${CSS.escape(settings.focusOrigin)}"]`)
  if (card === null) return
  scrolledToFocusOrigin = true
  card.scrollIntoView({ block: 'start' })
}

async function refresh (): Promise<void> {
  const apps = await settings.list()
  view.render(apps)
  scrollToFocusOriginOnce()
}

/** Two revoke paths, one button. A row for an app loaded this session carries
 * a live grant id; a row for an app that only exists on disk does not, and is
 * revoked by its capability instead (docs/open-questions.md A137). The button
 * looks and behaves identically either way -- a person should not have to know
 * or care whether the app happens to be open. */
async function revokeAndRefresh (origin: string, row: PermissionRow): Promise<void> {
  if (row.grantId === null) {
    await settings.revokeCapability(origin, row.capability)
  } else {
    await settings.revoke(origin, row.grantId)
  }
  await refresh()
}

void refresh()
