// A tab's right-click menu, composed from context-menu-groups.ts: what was
// clicked decides which groups show. Electron shows no menu at all unless one
// is built.
import { clipboard, Menu } from 'electron'
import type { BaseWindow, ContextMenuParams, MenuItem, MenuItemConstructorOptions, WebContents } from 'electron'
import type { CommandId } from '../shortcuts/commands.js'
import { engineLabelFor } from './context-menu-text.js'
import { startNavigation } from './leave-page-prompt.js'
import { downloadAsked } from '../downloads/asked-downloads.js'
import type { ShellServices } from './shell-services.js'
import {
  DEFAULT_CONTEXT, editableGroup, imageGroup, linkGroup, mediaGroup, pageGroup, selectionGroup, spellingGroup
} from './context-menu-groups.js'
import type { ContextMenuActions, ContextMenuContext, MenuParams } from './context-menu-groups.js'
import { togglePictureInPictureAt } from '../page-tools/pip.js'
import { searchUrlFor } from '../browsing/search-engines.js'

export type { ContextMenuActions, ContextMenuContext } from './context-menu-groups.js'

/** Separators only between two items: none first, none last, none twice. */
function compact (items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  const out: MenuItemConstructorOptions[] = []
  for (const item of items) {
    if (item.type === 'separator' && (out.length === 0 || out[out.length - 1]?.type === 'separator')) continue
    out.push(item)
  }
  while (out[out.length - 1]?.type === 'separator') out.pop()
  return out
}

/** Empty when there is nothing to offer; the caller then shows no menu. */
export function contextMenuTemplate (
  params: MenuParams,
  actions: ContextMenuActions,
  canInspect: boolean,
  context: ContextMenuContext = DEFAULT_CONTEXT
): MenuItemConstructorOptions[] {
  const specific = [
    spellingGroup(params, actions, context),
    linkGroup(params, actions),
    imageGroup(params, actions),
    mediaGroup(params, actions),
    selectionGroup(params, actions, context),
    editableGroup(params, actions, context)
  ]
  const groups = specific.some((group) => group.length > 0) ? specific : [pageGroup(actions, context)]
  if (canInspect) groups.push([{ label: 'Inspect Element', click: () => { actions.inspectAt(params.x, params.y) } }])
  return compact(groups
    .filter((group) => group.length > 0)
    .flatMap((group, i): MenuItemConstructorOptions[] => i === 0 ? group : [{ type: 'separator' }, ...group]))
}

export interface ContextMenuHost {
  readonly window: BaseWindow
  /** A kiosk opens no tab, window or private session from a menu: there is no strip to reach them, and a second
   * browser would bring the chrome the kiosk hides. */
  readonly kiosk?: boolean
  openInNewTab: (url: string) => void
  openInSplit?: (url: string) => void
  openInWindow?: (url: string) => void
  /** Absent in a private window, where there is no way back to the profile. */
  openInPrivate?: (url: string) => void
  /** Opens an address in a tab put in front: what a search of the selection does. */
  openInFront?: (url: string) => void
  /** Present for a tab's menu and absent for the chrome's, whose menu holds only edit items. `bare`: an internal page or the new-tab page. */
  readonly page?: { readonly bare: () => boolean, readonly viewSource?: () => boolean, readonly readable?: () => boolean, readonly reload?: () => void }
  /** What the menu reads: the search engine and the spelling switch. Absent in tests. */
  readonly services?: Pick<ShellServices, 'settings'>
  /** Runs a command on the window: Save, Print, Screenshot, View Source, Picture in Picture. */
  readonly runCommand?: (id: CommandId) => void
  /** The address bar's "Paste and Go". */
  readonly pasteAndGo?: () => void
  /** The address bar's "Always Show Full Addresses": whether it is on, and the flip. */
  readonly fullAddresses?: { readonly on: () => boolean, readonly toggle: () => void }
  /** Opens developer tools at a point of the page. Absent where they are not allowed: the menu then has no Inspect. */
  readonly inspect?: (x: number, y: number) => void
  /** What a feature adds below the page's own items, for a tab's menu: a kiosk and a bare page get none. */
  readonly extraItems?: (params: ContextMenuParams) => readonly MenuItem[]
}

export function showContextMenu (wc: WebContents, params: ContextMenuParams, host: ContextMenuHost): void {
  // The menu can outlive the tab: a page may close itself while it is open,
  // and a call on a destroyed webContents throws in the main process.
  const onTab = (act: () => void) => () => { if (!wc.isDestroyed()) act() }
  const settings = host.services?.settings
  const kiosk = host.kiosk === true
  const { runCommand, pasteAndGo } = host
  const [openInSplit, openInWindow, openInPrivate, openInFront] = kiosk ? [] : [host.openInSplit, host.openInWindow, host.openInPrivate, host.openInFront]
  const actions: ContextMenuActions = {
    cut: onTab(() => { wc.cut() }),
    copy: onTab(() => { wc.copy() }),
    paste: onTab(() => { wc.paste() }),
    selectAll: onTab(() => { wc.selectAll() }),
    undo: onTab(() => { wc.undo() }),
    redo: onTab(() => { wc.redo() }),
    pasteAndMatchStyle: onTab(() => { wc.pasteAndMatchStyle() }),
    copyText: (text) => { clipboard.writeText(text) },
    ...(kiosk ? {} : { openInNewTab: host.openInNewTab }),
    ...(openInSplit === undefined ? {} : { openInSplit }),
    ...(openInWindow === undefined ? {} : { openInWindow }),
    ...(openInPrivate === undefined ? {} : { openInPrivate }),
    ...(pasteAndGo === undefined ? {} : { pasteAndGo }),
    copyImageAt: (x, y) => { onTab(() => { wc.copyImageAt(x, y) })() },
    inspectAt: (x, y) => { onTab(() => { host.inspect?.(x, y) })() }
  }
  const context: ContextMenuContext = { ...DEFAULT_CONTEXT }
  if (host.fullAddresses !== undefined) {
    actions.toggleFullAddresses = host.fullAddresses.toggle
    context.fullAddresses = host.fullAddresses.on()
  }
  if (host.page !== undefined) {
    actions.saveUrl = (url) => { onTab(() => { downloadAsked(wc, url) })() }
    actions.navigate = {
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      // Started as the toolbar's buttons start them, so "Leave" in the page's leave question runs them again.
      back: onTab(() => { startNavigation(wc, () => { wc.navigationHistory.goBack() }) }),
      forward: onTab(() => { startNavigation(wc, () => { wc.navigationHistory.goForward() }) }),
      reload: onTab(() => { if (host.page?.reload !== undefined) host.page.reload(); else startNavigation(wc, () => { wc.reload() }) })
    }
    actions.replaceMisspelling = (word) => { onTab(() => { wc.replaceMisspelling(word) })() }
    actions.addToDictionary = (word) => { onTab(() => { wc.session.addWordToSpellCheckerDictionary(word) })() }
    if (runCommand !== undefined) {
      actions.run = runCommand
      // The video clicked, else the page's main one.
      actions.pipAt = (x, y) => {
        void togglePictureInPictureAt(params.frame, x, y).then((done) => { if (!done) runCommand('page.pip') })
      }
    }
    context.bare = host.page.bare()
    context.viewSource = host.page.viewSource?.() ?? true
    context.readable = host.page.readable?.() ?? false
    if (settings !== undefined) {
      context.spellcheckOn = settings.get('spellcheck.enabled')
      context.engineLabel = engineLabelFor(settings.get('search.engine'))
      actions.toggleSpellcheck = () => { settings.set('spellcheck.enabled', !context.spellcheckOn) }
      const open = openInFront ?? (kiosk ? undefined : host.openInNewTab)
      if (open !== undefined) {
        actions.search = (query) => { open(searchUrlFor(settings.get('search.engine'), settings.get('search.customUrl'), query)) }
      }
    }
  }
  const template = contextMenuTemplate(params, actions, host.inspect !== undefined, context)
  const extra = host.page === undefined || kiosk || context.bare ? [] : host.extraItems?.(params) ?? []
  if (template.length === 0 && extra.length === 0) return
  const items: Array<MenuItemConstructorOptions | MenuItem> = extra.length === 0 || template.length === 0 ? [...template, ...extra] : [...template, { type: 'separator' }, ...extra]
  Menu.buildFromTemplate(items).popup({ window: host.window, ...(params.frame !== null ? { frame: params.frame } : {}) })
}
