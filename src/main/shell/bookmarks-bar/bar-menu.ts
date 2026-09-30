// The right-click menu of the bookmarks bar, as a native menu template. Pure: what is offered follows from the
// model, and what each item does is handed in. Native menus are Title Case.
import type { MenuItemConstructorOptions } from 'electron'
import { OPEN_ALL_LIMIT } from './open-bookmark.js'

export type BarMenuTarget =
  | { kind: 'url' }
  | { kind: 'folder', pages: number }
  /** The empty part of the bar. */
  | { kind: 'bar' }

export interface BarMenuModel {
  target: BarMenuTarget
  /** A private window offers no second private session. */
  isPrivate: boolean
  barShown: boolean
}

export interface BarMenuActions {
  openInTab: () => void
  openInWindow: () => void
  openInPrivate: () => void
  openAll: () => void
  copyLink: () => void
  remove: () => void
  toggleBar: () => void
  /** Absent while the Bookmark manager command is still a stub: no row then. */
  openManager?: () => void
}

/** "Open All (7)", or "Open All (25 of 40)" when a folder holds more than one Open all makes. */
export function openAllLabel (pages: number): string {
  return pages > OPEN_ALL_LIMIT ? `Open All (${String(OPEN_ALL_LIMIT)} of ${String(pages)})` : `Open All (${String(pages)})`
}

export function barMenuTemplate (model: BarMenuModel, actions: BarMenuActions): MenuItemConstructorOptions[] {
  const { target } = model
  const separator: MenuItemConstructorOptions = { type: 'separator' }
  const common: MenuItemConstructorOptions[] = [
    { label: 'Show Bookmarks Bar', type: 'checkbox', checked: model.barShown, click: actions.toggleBar },
    ...(actions.openManager === undefined ? [] : [{ label: 'Bookmark Manager', click: actions.openManager }])
  ]
  if (target.kind === 'bar') return common
  if (target.kind === 'folder') {
    return [
      { label: openAllLabel(target.pages), enabled: target.pages > 0, click: actions.openAll },
      separator,
      { label: 'Delete', click: actions.remove },
      separator,
      ...common
    ]
  }
  return [
    { label: 'Open in New Tab', click: actions.openInTab },
    { label: 'Open in New Window', click: actions.openInWindow },
    ...(model.isPrivate ? [] : [{ label: 'Open in Private Window', click: actions.openInPrivate }]),
    separator,
    { label: 'Copy Link', click: actions.copyLink },
    { label: 'Delete', click: actions.remove },
    separator,
    ...common
  ]
}
