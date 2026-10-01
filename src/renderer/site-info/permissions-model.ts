// Which of a site's permission rows the popover lists, and which wait behind "Add a permission". Pure, so it is
// tested without a page.
import type { SiteKind } from '../../main/site-settings/kinds.js'
import type { SiteKindRow } from '../../main/site-settings/site-settings-controller.js'
import type { SitePermissionsView } from '../../main/site-settings/site-permissions-view.js'

export interface PermissionRows {
  /** The rows to show: answered or asked about, and any the person set in this visit (so a row they just put back to its default does not vanish under them). */
  readonly listed: readonly SiteKindRow[]
  /** The rest, in the order the table lists them. */
  readonly more: readonly SiteKindRow[]
}

export function splitRows (view: SitePermissionsView, touched: ReadonlySet<SiteKind>): PermissionRows {
  const shown = new Set<SiteKind>([...view.shown, ...touched])
  return {
    listed: view.rows.filter((row) => shown.has(row.kind)),
    more: view.rows.filter((row) => !shown.has(row.kind))
  }
}
