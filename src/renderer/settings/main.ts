import type { AppPermissions, PermissionRow, PickedPathRow, SiteNotificationRow } from '../../main/permissions/permissions.js'
import type { CapabilityKind, GrantId } from '../../contracts/index.js'
import { createPermissionsListView } from './permissions-view.js'

// The settings window's whole job: fetch the list, render it, revoke on
// click, re-fetch. No live push channel exists for this yet (unlike the
// chrome view's ShellState) -- every render is a fresh `list()` round trip,
// which is cheap enough at the scale this page ever shows (a handful of
// apps) and keeps this file simple. The panel is built fresh on every open
// (src/main/permissions-panel.ts), so unlike the window this replaced there
// is no stale-`focusOrigin` gap -- a reopen is always a fresh load.

interface OrivonSettings {
  list: () => Promise<readonly AppPermissions[]>
  revoke: (origin: string, grantId: GrantId) => Promise<void>
  /** For a row whose app is not loaded this session -- see revokeAndRefresh. */
  revokeCapability: (origin: string, capability: CapabilityKind) => Promise<void>
  /** D-0007's own revoke, addressed by pickId. */
  revokePickedPath: (origin: string, pickId: string) => Promise<void>
  listSiteNotifications: () => Promise<readonly SiteNotificationRow[]>
  /** Forgets a site's notification answer; it is asked again next time. */
  resetSiteNotifications: (origin: string) => Promise<void>
  reportHeight: (height: number) => void
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

// A hard throw, unlike newtab.ts's graceful degrade: this panel's preload
// path is fixed at construction (permissions-panel.ts) and never anything
// but preload/settings.ts, so `orivonSettings` missing here means the
// preload itself failed, not a legitimately unprivileged load.
const settings = must(window.orivonSettings, 'orivonSettings not exposed -- preload did not run')

const list = must(document.querySelector<HTMLDivElement>('#apps-list'), '#apps-list missing')
const emptyState = must(document.querySelector<HTMLElement>('#empty-state'), '#empty-state missing')

const view = createPermissionsListView(
  list,
  emptyState,
  (origin, row) => { void revokeAndRefresh(origin, row) },
  (origin, row) => { void revokePickedPathAndRefresh(origin, row) },
  (row) => { void resetSiteAndRefresh(row) }
)

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

/** Measured from where the content actually ENDS, not from any element's own
 * height. `.page` is `height: 100%` of the panel (style.css), so both its
 * offsetHeight and its scrollHeight are floored at the panel's current
 * height -- feeding either back to main gives a fixed point that can grow
 * but never shrink, which is how this first went wrong (the panel stuck at
 * its 180px opening size). Reported after every render: the list arrives
 * over IPC, so the first paint is always an empty one. */
function reportContentHeight (): void {
  const page = document.querySelector<HTMLElement>('.page')
  if (page === null) return

  const top = page.getBoundingClientRect().top
  let bottom = top
  for (const child of page.children) {
    if (child instanceof HTMLElement && child.hidden) continue
    bottom = Math.max(bottom, child.getBoundingClientRect().bottom)
  }
  const paddingBottom = parseFloat(getComputedStyle(page).paddingBottom)
  settings.reportHeight(Math.ceil(bottom - top + paddingBottom))
}

async function refresh (): Promise<void> {
  const [apps, sites] = await Promise.all([settings.list(), settings.listSiteNotifications()])
  view.render(apps, sites)
  scrollToFocusOriginOnce()
  reportContentHeight()
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

/** D-0007's own revoke button -- always addressed by pickId, whether or
 * not the owning app is loaded this session (Broker.revokeUserSelectedPath
 * works either way), so there is no `PermissionRow.grantId === null`-style
 * branch to make here. */
async function revokePickedPathAndRefresh (origin: string, row: PickedPathRow): Promise<void> {
  await settings.revokePickedPath(origin, row.pickId)
  await refresh()
}

async function resetSiteAndRefresh (row: SiteNotificationRow): Promise<void> {
  await settings.resetSiteNotifications(row.origin)
  await refresh()
}

void refresh()
