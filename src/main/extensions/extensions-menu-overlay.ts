// The Extensions menu: a card under the toolbar's puzzle button listing every
// enabled extension, with a pin, the extension's own action and a few more
// actions each. This is the overlay's declaration and what a request does; the
// rows are built in ./extensions-menu-model.ts, and a feature adds to the menu
// through ./extensions-menu-points.ts. Tied to Electron.
import { sendChromeEvent } from '../shell/shell-events.js'
import { CLOSE_LIKE_POPUP } from '../overlays/overlay-types.js'
import type { OverlayDef, OverlayHandler, OverlayWindow } from '../overlays/overlay-types.js'
import { isPinned } from './action-pins.js'
import { extensionOpenedUrl } from './extension-url-policy.js'
import { extensionsMenuDeps } from './extensions-menu-deps.js'
import type { ExtensionsMenuDeps } from './extensions-menu-deps.js'
import { buildRows, anchorFrom, asRequest, fallbackAnchor, isExtensionId, siteHost } from './extensions-menu-model.js'
import { openExtensionTab } from './extension-opened-pages.js'
import { activateTabShowing } from './extension-options-tab.js'
import type { MenuPayload, Rect } from './extensions-menu-model.js'
import { EXTENSIONS_BUTTON_MODULE, EXTENSIONS_MENU_OVERLAY, EXTENSION_STORE_URL } from './extensions-menu-names.js'
import { EXTENSION_MENU_REQUESTS, EXTENSION_MENU_ROW_PARTS } from './extensions-menu-points.js'
import type { MenuRequestContext } from './extensions-menu-points.js'

const MENU_WIDTH = 340

function contained<T> (what: string, fallback: T, run: () => T): T {
  try {
    return run()
  } catch (error) {
    console.error(`[extensions] ${what} failed:`, error)
    return fallback
  }
}

export function createExtensionsMenu (win: OverlayWindow, deps: ExtensionsMenuDeps): OverlayHandler {
  const { window, services } = win
  /** Where the menu was opened from: a popup an extension opens hangs under it. */
  let anchor: Rect | undefined

  const setExpanded = (value: boolean): void => { sendChromeEvent(window, EXTENSIONS_BUTTON_MODULE, { type: 'expanded', value }) }

  async function payload (): Promise<MenuPayload> {
    const active = window.tabs.getState()
    const tab = active.tabs.find((candidate) => candidate.id === active.activeTabId)
    const contents = window.tabs.activeWebContents()
    const pinNew = services.settings.get('extensions.pinNew')
    const entries = await deps.entries()
    const rows = buildRows(
      entries,
      deps.actions(contents === undefined || contents.isDestroyed() ? undefined : contents.id),
      (id) => isPinned(deps.prefs.get(id), pinNew),
      (id) => Object.assign({}, ...EXTENSION_MENU_ROW_PARTS.map((part) => contained(`menu row part for ${id}`, {}, () => part(id, { prefs: deps.prefs, win }))))
    )
    return {
      site: siteHost(tab?.url, tab !== undefined && !tab.isInternal && !tab.isNewTab),
      activatable: contents !== undefined && !contents.isDestroyed() && deps.canActivate(contents),
      rows
    }
  }

  /** The id of an enabled extension the request names, else undefined: a forged or stale id does nothing. */
  function enabledId (value: unknown): string | undefined {
    return isExtensionId(value) && deps.isEnabled(value) ? value : undefined
  }

  function open (target: string | undefined): void {
    if (target === undefined) return
    win.close()
    if (!activateTabShowing(services.windows.all(), target)) openExtensionTab(window.tabs, target)
  }

  async function run (type: string, body: Record<string, unknown>): Promise<unknown> {
    switch (type) {
      case 'manage-all':
        win.close()
        window.tabs.openInternal('extensions')
        return undefined
      case 'store':
        win.close()
        window.tabs.createTab(EXTENSION_STORE_URL)
        return undefined
      case 'activate': case 'pin': case 'options': case 'manage': case 'remove': {
        const id = enabledId(body['id'])
        return id === undefined ? undefined : await runOn(type, id, body)
      }
    }
    if (!Object.hasOwn(EXTENSION_MENU_REQUESTS, type)) return undefined
    const context: MenuRequestContext = {
      prefs: deps.prefs,
      win,
      extensionId: (request) => enabledId(request['id']),
      payload,
      close: () => { win.close() }
    }
    return await EXTENSION_MENU_REQUESTS[type]?.(body, context)
  }

  /** A request about one enabled extension. */
  async function runOn (type: string, id: string, body: Record<string, unknown>): Promise<unknown> {
    switch (type) {
      case 'activate': {
        const contents = window.tabs.activeWebContents()
        if (!deps.actions(contents?.id).has(id)) {
          win.close()
          window.tabs.openInternal('extensions', `/details?id=${id}`)
          return undefined
        }
        if (contents === undefined || contents.isDestroyed() || !deps.canActivate(contents)) return undefined
        // Closed first: closing hands focus back to the page, and the popup opening afterwards keeps it.
        win.close()
        const at = anchor ?? fallbackAnchor(window.window.getContentBounds().width)
        contained(`running the action of ${id}`, undefined, () => { deps.activate(id, contents, at) })
        return undefined
      }
      case 'pin': {
        const pinNew = services.settings.get('extensions.pinNew')
        const wanted = typeof body['pinned'] === 'boolean' ? body['pinned'] : !isPinned(deps.prefs.get(id), pinNew)
        deps.prefs.update(id, { pinned: wanted })
        return await payload()
      }
      case 'options': {
        const url = deps.optionsUrl(id)
        open(url === undefined ? undefined : extensionOpenedUrl(url, deps.isLoaded))
        return undefined
      }
      case 'manage':
        win.close()
        window.tabs.openInternal('extensions', `/details?id=${id}`)
        return undefined
      default:
        await deps.uninstall(id)
        services.internalPages.publish('extensions.changed', undefined, ['extensions'])
        return await payload()
    }
  }

  return {
    show: async (opened) => {
      anchor = anchorFrom(opened)
      setExpanded(true)
      return await payload()
    },
    request: async (command) => {
      const asked = asRequest(command)
      if (asked === undefined) return undefined
      try {
        return await run(asked.type, asked.body)
      } catch (error) {
        console.error(`[extensions] menu request ${asked.type} failed:`, error)
        return undefined
      }
    },
    closed: () => { setExpanded(false) }
  }
}

export const extensionsMenuOverlay: OverlayDef = {
  name: EXTENSIONS_MENU_OVERLAY,
  placement: { kind: 'anchor', width: MENU_WIDTH, align: 'right' },
  surface: 'panel',
  focus: 'take',
  layer: 'popup',
  closeOn: CLOSE_LIKE_POPUP,
  keep: 'fresh',
  height: { initial: 160, max: 460 },
  attach: (win) => {
    const deps = extensionsMenuDeps()
    // Before the extension host exists (a private window) the menu has nothing to list or run.
    return deps === undefined ? { request: () => undefined } : createExtensionsMenu(win, deps)
  }
}
