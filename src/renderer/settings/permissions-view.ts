import type { AppPermissions, PermissionRow, PickedPathRow, SiteNotificationRow } from '../../main/permissions/permissions.js'
import type { GrantId } from '../../contracts/index.js'

// Renders the settings window's whole list of app cards -- one card per
// `AppPermissions`, one row per `PermissionRow`. Mirrors bookmarks-view.ts's
// shape (a factory closing over the container elements, a single `render`
// call rebuilding the list on every fresh fetch) rather than diffing: the
// list here is at most a handful of apps, so a rebuild is not observable as
// jank, and it is what keeps this module simple enough to trust at a
// glance.
//
// Never innerHTML (security-model.md T1/T10/T12/T17) -- `row.message` and
// `app.appName` both ultimately trace back to app-controlled input (a
// manifest's own `name`, and grant-prompt-render.ts's rendering of
// app-declared patterns), even though neither can inject markup through
// `textContent`.

export interface PermissionsListView {
  /** `sites`: each site's notification answer, listed after the apps. */
  render: (apps: readonly AppPermissions[], sites?: readonly SiteNotificationRow[]) => void
}

export function createPermissionsListView (
  list: HTMLDivElement,
  emptyState: HTMLElement,
  onRevoke: (origin: string, row: PermissionRow) => void,
  // D-0007: a picked path's own revoke -- a SEPARATE callback because it is
  // addressed by pickId, not by (grantId | capability) the way a
  // PermissionRow is. Optional so an existing caller (none left in this
  // tree, but nothing stops one) still compiles unchanged.
  onRevokePickedPath?: (origin: string, row: PickedPathRow) => void,
  onResetSite?: (row: SiteNotificationRow) => void
): PermissionsListView {
  function render (apps: readonly AppPermissions[], sites: readonly SiteNotificationRow[] = []): void {
    list.replaceChildren()
    emptyState.hidden = apps.length + sites.length > 0
    for (const app of apps) {
      list.append(renderCard(app, onRevoke, onRevokePickedPath))
    }
    for (const site of sites) {
      list.append(renderSiteCard(site, onResetSite))
    }
  }

  return { render }
}

function renderCard (
  app: AppPermissions,
  onRevoke: (origin: string, row: PermissionRow) => void,
  onRevokePickedPath?: (origin: string, row: PickedPathRow) => void
): HTMLElement {
  const card = document.createElement('section')
  card.className = 'app-card'
  card.setAttribute('role', 'listitem')
  // Read by main.ts's one-time scroll-to-focusOrigin -- CSS.escape guards
  // an origin containing a character `[data-origin="..."]` would otherwise
  // need escaping for (a non-standard port's ":", say).
  card.dataset['origin'] = app.origin

  const heading = document.createElement('div')
  heading.className = 'app-heading'
  const originEl = document.createElement('span')
  originEl.className = 'app-origin'
  originEl.textContent = app.origin
  const claim = document.createElement('span')
  claim.className = 'app-claim'
  // Same literal phrasing grant-prompt-render.ts's install prompt uses --
  // "same fact, same words" (this lane's own brief).
  claim.textContent = `Claims to be "${app.appName}".`
  heading.append(originEl, claim)

  const rows = document.createElement('ul')
  rows.className = 'permission-rows'
  for (const row of app.rows) {
    rows.append(renderRow(app.origin, row, onRevoke))
  }
  // Picked paths share the SAME list and the SAME row styling as grant
  // rows -- D-0007's "beside that app's network and file access", not a
  // second section. Deliberately plain: no distinct markup beyond what a
  // grant row already has (this lane's owner checkpoint, queue item 4.3 --
  // see this lane's log for the wording this renders, still unreviewed).
  for (const pickedPathRow of app.pickedPathRows) {
    rows.append(renderPickedPathRow(app.origin, pickedPathRow, onRevokePickedPath))
  }

  card.append(heading, rows)
  return card
}

/** Shared by every row below -- one `.permission-row` markup: a message and one button, differing only in the button's word and what it addresses. */
function renderRowElement (message: string, warning: boolean, onRevoke: () => void, action = 'Revoke'): HTMLElement {
  const li = document.createElement('li')
  li.className = 'permission-row'
  li.classList.toggle('warning', warning)

  const messageEl = document.createElement('span')
  messageEl.className = 'permission-message'
  messageEl.textContent = message

  const revoke = document.createElement('button')
  revoke.type = 'button'
  revoke.className = 'revoke-btn'
  revoke.textContent = action
  revoke.setAttribute('aria-label', `${action}: ${message}`)
  revoke.addEventListener('click', onRevoke)

  li.append(messageEl, revoke)
  return li
}

function renderRow (origin: string, row: PermissionRow, onRevoke: (origin: string, row: PermissionRow) => void): HTMLElement {
  // The whole row, not just an id: a row for an app that is not loaded has
  // no live grant id, and choosing between the two revoke paths is the
  // caller's job rather than this view's.
  return renderRowElement(row.message, row.warning, () => { onRevoke(origin, row) })
}

function renderPickedPathRow (origin: string, row: PickedPathRow, onRevokePickedPath?: (origin: string, row: PickedPathRow) => void): HTMLElement {
  return renderRowElement(row.message, row.warning, () => { onRevokePickedPath?.(origin, row) })
}

/** A website's card: its origin and its notification answer, with Reset. A
 * site claims no name, so the card has no claim line. */
function renderSiteCard (site: SiteNotificationRow, onReset?: (row: SiteNotificationRow) => void): HTMLElement {
  const card = document.createElement('section')
  card.className = 'app-card'
  card.setAttribute('role', 'listitem')
  card.dataset['origin'] = site.origin

  const heading = document.createElement('div')
  heading.className = 'app-heading'
  const originEl = document.createElement('span')
  originEl.className = 'app-origin'
  originEl.textContent = site.origin
  heading.append(originEl)

  const rows = document.createElement('ul')
  rows.className = 'permission-rows'
  rows.append(renderRowElement(site.message, false, () => { onReset?.(site) }, 'Reset'))

  card.append(heading, rows)
  return card
}
