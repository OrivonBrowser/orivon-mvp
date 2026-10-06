// Runs `chrome.sidePanel` in the real browser: makes the page of an extension's panel (one view per window and
// extension), reacts to the session's load and unload of extensions and to the shell's tabs, and feeds the browser's
// own input to the gesture ledger. The decisions are side-panel-driver.ts's, the argument rules side-panel-api.ts's.
import { app, WebContentsView } from 'electron'
import type { WebContents } from 'electron'
import { setActionClickInterceptor } from 'orivon:crx-extensions-browser-action'
import { showContextMenu } from '../shell/context-menu.js'
import { PANEL_POPOVER_BACKGROUND, resolveThemeColor } from '../shell/theme-colors.js'
import type { ShellWindow } from '../shell/window-registry.js'
import { DELIBERATE_INPUT } from '../site-settings/tab-interaction.js'
import { onGuestChosen, panelOf, setGuestEntries } from '../side-panel/side-panel-host.js'
import type { ExtensionApiContext } from './api/api-types.js'
import { extensionPagesAroundReload } from './extension-host.js'
import { isLoadedExtension } from './extension-host-impl.js'
import { openExtensionTab } from './extension-opened-pages.js'
import { setupWindowOpenPolicy } from './extension-popup-policy.js'
import { extensionOpenedUrl } from './extension-url-policy.js'
import { readExtensionFacts } from './extensions-view-runner.js'
import { createPanelDriver } from './side-panel-driver.js'
import type { PanelDriver, PanelPage, PanelPageEvents } from './side-panel-driver.js'
import { createSidePanelApi, isOrdinaryTab } from './side-panel-api.js'
import type { SidePanelDriver } from './side-panel-api.js'
import { createBehaviorStore } from './side-panel-behavior-file.js'
import { sidePanelGestures } from './side-panel-gesture.js'
import { sidePanelTabClosing } from './side-panel-tab-closing.js'
import { createSidePanelOptions } from './side-panel-options.js'
import { registerSidePanelPage } from './side-panel-pages.js'

/** A first load that has not ended by now is shown anyway: a slow page is better seen than waited for. */
const FIRST_LOAD_LIMIT_MS = 15_000
const EXTENSION_PAGE = /^chrome-extension:\/\/([a-p]{32})\//

let running: PanelDriver | undefined

/** Closes every panel page of `extensionId` and settles once they are gone: an uninstall runs it before it empties the extension's storage. */
export async function closeSidePanels (extensionId: string): Promise<void> {
  await running?.closeAll(extensionId)
}

let menuAction: ((extensionId: string) => (() => void) | undefined) | undefined

/** What an action's right-click menu runs for "Open Side Panel": undefined when the extension has no panel for the tab in front or the window has no room for one. */
export function sidePanelMenuAction (extensionId: string): (() => void) | undefined {
  return menuAction?.(extensionId)
}

/** The extension's own key for its panel. False when it has none for this tab, so the key reaches the page. */
export function openSidePanelFor (extensionId: string, tab: WebContents, window: ShellWindow): boolean {
  return running?.openFromKey(extensionId, window, tab.id) === true
}

function makePage (ctx: ExtensionApiContext, extensionId: string, window: ShellWindow, url: string, events: PanelPageEvents): PanelPage {
  const view = new WebContentsView({
    webPreferences: { session: ctx.session, sandbox: true, nodeIntegration: false, nodeIntegrationInWorker: false, contextIsolation: true, disableDialogs: true }
  })
  const contents = view.webContents
  view.setBackgroundColor(resolveThemeColor(PANEL_POPOVER_BACKGROUND))
  registerSidePanelPage(contents, window.window)
  setupWindowOpenPolicy(contents, { services: ctx.shell, isLoaded: isLoadedExtension })

  // The panel stays on its extension's pages: a link that leaves them opens as a tab, through the same address policy a tab an extension opens goes through.
  const prefix = `chrome-extension://${extensionId}/`
  const keepInside = (event: { preventDefault: () => void }, target: string): void => {
    if (target.startsWith(prefix)) return
    event.preventDefault()
    const address = extensionOpenedUrl(target, isLoadedExtension)
    if (address !== undefined) openExtensionTab(window.tabs, address)
  }
  contents.on('will-navigate', (event, target) => { keepInside(event, target) })
  contents.on('will-redirect', (event, target) => { keepInside(event, target) })
  // Only text editing gets a menu, as in the shell's own popups: nothing in it opens a tab or reaches the page's tools.
  contents.on('context-menu', (_event, params) => {
    if (!params.isEditable && params.selectionText === '') return
    showContextMenu(contents, params, { window: window.window, kiosk: true, openInNewTab: () => {} })
  })
  contents.on('render-process-gone', events.gone)

  const destroyed = new Promise<void>((resolve) => {
    contents.once('destroyed', () => { events.destroyed(); resolve() })
  })
  const ready = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, FIRST_LOAD_LIMIT_MS)
    const done = (): void => { clearTimeout(timer); resolve() }
    contents.once('did-stop-loading', done)
    void destroyed.then(done)
  })
  void contents.loadURL(url).catch(() => {})

  return {
    view,
    ready,
    destroyed,
    alive: () => !contents.isDestroyed(),
    navigate: (target, keepFocus) => {
      if (contents.isDestroyed()) return
      if (!keepFocus) {
        // A view that takes focus as its page commits would take the keyboard from the tab: it goes back to the page.
        const back = (): void => { setImmediate(() => { panelOf(window)?.focusPage() }) }
        contents.on('focus', back)
        contents.once('did-stop-loading', () => { contents.removeListener('focus', back) })
      }
      void contents.loadURL(target).catch(() => {})
    },
    destroy: () => { if (!contents.isDestroyed()) contents.close() }
  }
}

/** The driver the API module runs against, with its own wiring done: called once from the module's `install`. */
function makeRunner (ctx: ExtensionApiContext): SidePanelDriver {
  const options = createSidePanelOptions({
    manifestOf: (id) => ctx.session.extensions.getExtension(id)?.manifest,
    holds: (id) => ctx.held(id, 'sidePanel')
  })

  const behavior = createBehaviorStore((id) => ctx.session.extensions.getExtension(id)?.path)
  const facts = new Map<string, { title: string, icon?: string | undefined }>()
  const driver = createPanelDriver({
    options,
    windows: () => ctx.shell()?.windows.all().filter((entry) => !entry.window.isDestroyed()) ?? [],
    hostOf: (window) => panelOf(window),
    frontTab: (window) => {
      const front = window.tabs.activeWebContents()
      return front === undefined || front.isDestroyed() || ctx.tab(front.id) === undefined || !isOrdinaryTab(ctx, front) ? undefined : front.id
    },
    candidates: () => ctx.session.extensions.getAllExtensions().map((extension) => extension.id).filter((id) => ctx.held(id, 'sidePanel')),
    facts: (id) => facts.get(id) ?? { title: ctx.session.extensions.getExtension(id)?.name ?? id },
    publish: (entries) => { setGuestEntries(entries) },
    createPage: (id, window, url, events) => makePage(ctx, id, window, url, events),
    fire: (id, name, info) => { ctx.sendEvent(id, `sidePanel.${name}`, info) },
    reloading: extensionPagesAroundReload.reloading
  })
  running = driver

  onGuestChosen((window, entryId) => { driver.chosen(window, entryId) })
  ctx.onShell((shell) => {
    shell.tabLifecycle.subscribe({
      tabActivated: (contents) => {
        const found = shell.windows.findTab(contents)
        if (found !== null) driver.sync(found.window)
      },
      ...sidePanelTabClosing(driver)
    })
    driver.republish()
  })

  const extensions = ctx.session.extensions
  extensions.on('extension-loaded', (_event, extension) => {
    options.setOpenOnActionClick(extension.id, behavior.read(extension.id))
    void readExtensionFacts({ path: extension.path, name: extension.name }).then((read) => {
      facts.set(extension.id, { title: read.resolvedName, icon: read.iconDataUrl })
      driver.republish()
    }).catch(() => {})
    driver.extensionLoaded(extension.id)
  })
  extensions.on('extension-unloaded', (_event, extension) => {
    sidePanelGestures.clear(extension.id)
    if (!extensionPagesAroundReload.reloading(extension.id)) {
      options.forget(extension.id)
      facts.delete(extension.id)
    }
    driver.extensionUnloaded(extension.id)
  })

  // Input the browser itself saw on one of an extension's own pages (a click or a key), whatever surface shows it.
  app.on('web-contents-created', (_event, contents) => {
    contents.on('input-event', (_inputEvent, input) => {
      if (!DELIBERATE_INPUT.has(input.type)) return
      const id = EXTENSION_PAGE.exec(contents.getURL())?.[1]
      if (id !== undefined) sidePanelGestures.record(id)
    })
  })

  menuAction = (extensionId) => {
    const window = ctx.shell()?.windows.focused()
    const front = window?.tabs.activeWebContents()
    if (window === undefined || front === undefined || front.isDestroyed()) return undefined
    const tabId = isOrdinaryTab(ctx, front) ? front.id : undefined
    if (options.panelFor(extensionId, tabId) === undefined || panelOf(window)?.canShow() !== true) return undefined
    return () => { driver.openFromMenu(extensionId, window, tabId) }
  }

  setActionClickInterceptor((extensionId, tab) => {
    const found = ctx.shell()?.windows.findTab(tab)
    if (found == null) return false
    return driver.actionClick(extensionId, found.window, isOrdinaryTab(ctx, tab) ? tab.id : undefined)
  })

  return {
    options,
    gesture: sidePanelGestures,
    side: () => ctx.shell()?.settings.get('sidePanel.side') === 'left' ? 'left' : 'right',
    optionsChanged: (id) => { driver.optionsChanged(id) },
    behaviorChanged: (id) => {
      behavior.write(id, options.openOnActionClick(id))
      driver.optionsChanged(id)
    },
    open: async (target) => { await driver.open(target) },
    close: async (target) => { await driver.close(target) }
  }
}

export const sidePanelApi = createSidePanelApi(makeRunner)
