// A tab's right-click menu: the edit commands, the link and image commands,
// and Inspect Element where developer tools are allowed. Electron shows no
// menu at all unless one is built.
import { clipboard, Menu } from 'electron'
import type { BaseWindow, ContextMenuParams, MenuItemConstructorOptions, WebContents } from 'electron'
import { sanitizeDirectUrl } from '../browsing/omnibox.js'

export interface ContextMenuActions {
  cut: () => void
  copy: () => void
  paste: () => void
  selectAll: () => void
  copyText: (text: string) => void
  openInNewTab: (url: string) => void
  copyImageAt: (x: number, y: number) => void
  inspectAt: (x: number, y: number) => void
}

type MenuParams = Pick<ContextMenuParams, 'x' | 'y' | 'linkURL' | 'mediaType' | 'hasImageContents' | 'isEditable' | 'selectionText' | 'editFlags'>

function editItems (params: MenuParams, actions: ContextMenuActions): MenuItemConstructorOptions[] {
  const flags = params.editFlags
  if (params.isEditable) {
    return [
      { label: 'Cut', enabled: flags.canCut, click: actions.cut },
      { label: 'Copy', enabled: flags.canCopy, click: actions.copy },
      { label: 'Paste', enabled: flags.canPaste, click: actions.paste },
      { type: 'separator' },
      { label: 'Select All', enabled: flags.canSelectAll, click: actions.selectAll }
    ]
  }
  const items: MenuItemConstructorOptions[] = []
  if (params.selectionText !== '') items.push({ label: 'Copy', enabled: flags.canCopy, click: actions.copy })
  if (flags.canSelectAll) items.push({ label: 'Select All', click: actions.selectAll })
  return items
}

/** Empty when there is nothing to offer; the caller then shows no menu. */
export function contextMenuTemplate (params: MenuParams, actions: ContextMenuActions, canInspect: boolean): MenuItemConstructorOptions[] {
  const groups: MenuItemConstructorOptions[][] = []
  if (params.linkURL !== '') {
    const link: MenuItemConstructorOptions[] = []
    // Only what a fresh tab can load: the same check window.open targets get.
    const openable = sanitizeDirectUrl(params.linkURL)
    if (openable !== null) link.push({ label: 'Open Link in New Tab', click: () => { actions.openInNewTab(openable) } })
    link.push({ label: 'Copy Link Address', click: () => { actions.copyText(params.linkURL) } })
    groups.push(link)
  }
  if (params.mediaType === 'image' && params.hasImageContents) {
    groups.push([{ label: 'Copy Image', click: () => { actions.copyImageAt(params.x, params.y) } }])
  }
  groups.push(editItems(params, actions))
  if (canInspect) groups.push([{ label: 'Inspect Element', click: () => { actions.inspectAt(params.x, params.y) } }])
  return groups
    .filter((group) => group.length > 0)
    .flatMap((group, i): MenuItemConstructorOptions[] => i === 0 ? group : [{ type: 'separator' }, ...group])
}


export interface ContextMenuHost {
  readonly window: BaseWindow
  openInNewTab: (url: string) => void
  /** Opens developer tools at a point of the page. Absent where they are not allowed: the menu then has no Inspect. */
  readonly inspect?: (x: number, y: number) => void
}

export function showContextMenu (wc: WebContents, params: ContextMenuParams, host: ContextMenuHost): void {
  // The menu can outlive the tab: a page may close itself while it is open,
  // and a call on a destroyed webContents throws in the main process.
  const onTab = (act: () => void) => () => { if (!wc.isDestroyed()) act() }
  const template = contextMenuTemplate(params, {
    cut: onTab(() => { wc.cut() }),
    copy: onTab(() => { wc.copy() }),
    paste: onTab(() => { wc.paste() }),
    selectAll: onTab(() => { wc.selectAll() }),
    copyText: (text) => { clipboard.writeText(text) },
    openInNewTab: host.openInNewTab,
    copyImageAt: (x, y) => { onTab(() => { wc.copyImageAt(x, y) })() },
    inspectAt: (x, y) => { onTab(() => { host.inspect?.(x, y) })() }
  }, host.inspect !== undefined)
  if (template.length === 0) return
  Menu.buildFromTemplate(template).popup({ window: host.window, ...(params.frame !== null ? { frame: params.frame } : {}) })
}
