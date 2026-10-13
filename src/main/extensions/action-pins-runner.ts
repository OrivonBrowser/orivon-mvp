// Pinning, acted on: which actions the toolbar list shows, what
// `chrome.action.getUserSettings` answers, the `onUserSettingsChanged` event,
// the right-click menu of a toolbar action, and the dependencies the
// Extensions menu overlay reads. An API module so it runs once, with the
// router and the host in reach, before the first extension loads.
import { setActionMenuBuilder, setActionVisibilityCheck } from 'orivon:crx-extensions-browser-action'
import type { WebContents } from 'electron'
import type { ElectronChromeExtensions } from 'orivon:crx-extensions'
import type { ShellServices } from '../shell/shell-services.js'
import type { TabManager } from '../shell/tabs.js'
import { actionMenuTemplate } from './action-context-menu.js'
import type { ExtensionApiContext, ExtensionApiModule } from './api/api-types.js'
import { isPinned } from './action-pins.js'
import { setExtensionsMenuDeps } from './extensions-menu-deps.js'
import { optionsPageUrl } from './extensions-menu-model.js'
import { extensionOpenedUrl } from './extension-url-policy.js'
import { openExtensionTab } from './extension-opened-pages.js'
import { extensionPagePartition } from './profile-registry.js'
import { activateTabShowing } from './extension-options-tab.js'
import { readExtensionFacts } from './extensions-view-runner.js'
import { sidePanelMenuAction } from './side-panel-runner.js'

const USER_SETTINGS_EVENT = 'action.onUserSettingsChanged'

/** What `watchPinSetting` runs when `extensions.pinNew` changes: one refresh for each library instance. */
const refreshers = new Set<() => void>()

/**
 * What every library instance (the default session's and each profile session's) needs of the pins: the answer to
 * `chrome.action.getUserSettings`, the `onUserSettingsChanged` event and a toolbar told its list changed. The process-wide
 * parts (which actions the toolbar shows, the menu, the Extensions menu) are `install`'s alone.
 */
function installPerInstance (ctx: ExtensionApiContext): { pinned: (id: string) => boolean, known: Map<string, boolean> } {
  const pinNew = (): boolean => ctx.shell()?.settings.get('extensions.pinNew') ?? true
  const pinned = (id: string): boolean => isPinned(ctx.prefs.get(id), pinNew())
  /** What each extension was last known to show, so only a real change is told to it. */
  const known = new Map<string, boolean>()

  // The library registered its own answer first; a later `handle` of the same name replaces it.
  ctx.handle('browserAction.getUserSettings', (event) => ({ isOnToolbar: pinned(event.extension.id) }))

  const refresh = (ids: Iterable<string>): void => {
    for (const id of ids) {
      const now = pinned(id)
      if (known.get(id) === now) continue
      known.set(id, now)
      ctx.sendEvent(id, USER_SETTINGS_EVENT, { isOnToolbar: now })
    }
    ctx.host.notifyActionsChanged()
  }
  // What an extension shows when it loads is what it is known to have been told, so a later change is a real one.
  ctx.session.extensions.on('extension-loaded', (_event, extension) => { known.set(extension.id, pinned(extension.id)) })
  ctx.prefs.onChange((id) => { refresh([id]) })
  refreshers.add(() => { refresh([...known.keys()]) })
  return { pinned, known }
}

/** The part of the pins that a profile session's library instance has of its own. */
export const profileActionSettingsApi: ExtensionApiModule = { name: 'action-user-settings', install: (ctx) => { installPerInstance(ctx) } }

function install (ctx: ExtensionApiContext): void {
  const { pinned, known } = installPerInstance(ctx)

  setActionVisibilityCheck((id) => {
    const now = pinned(id)
    known.set(id, now)
    return now
  })

  const manifestOf = (id: string): unknown => ctx.session.extensions.getExtension(id)?.manifest
  const isLoaded = (id: string): boolean => ctx.session.extensions.getExtension(id) != null
  const focusedTabs = (): TabManager | undefined => ctx.shell()?.windows.focused()?.tabs
  /** The library instance that serves the session `tab` runs in; the default session's for no tab. */
  const hostOfTab = (tab: WebContents | undefined): ElectronChromeExtensions | undefined =>
    tab === undefined || tab.isDestroyed() ? ctx.host : ctx.hostFor(tab.session)

  setActionMenuBuilder((id, extensionItems, toolbarSession) => actionMenuTemplate({
    name: ctx.session.extensions.getExtension(id)?.name ?? id,
    hasOptions: optionsPageUrl(id, manifestOf(id)) !== undefined,
    pinned: pinned(id),
    extensionItems,
    openSidePanel: sidePanelMenuAction(id),
    openOptions: () => {
      const url = optionsPageUrl(id, manifestOf(id))
      const target = url === undefined ? undefined : extensionOpenedUrl(url, isLoaded)
      const tabs = focusedTabs()
      if (target === undefined || activateTabShowing(ctx.shell()?.windows.all() ?? [], target, toolbarSession)) return
      if (tabs !== undefined) openExtensionTab(tabs, target, extensionPagePartition(toolbarSession, target))
    },
    togglePin: () => { ctx.prefs.update(id, { pinned: !pinned(id) }) },
    manage: () => { focusedTabs()?.openInternal('extensions', `/details?id=${id}`) },
    remove: () => { focusedTabs()?.openInternal('extensions', `/details?id=${id}`) }
  }))

  setExtensionsMenuDeps({
    entries: async () => {
      const enabled = (ctx.extensions()?.list() ?? []).filter((entry) => entry.enabled)
      return await Promise.all(enabled.map(async (entry) => {
        const facts = await readExtensionFacts(entry)
        return { id: entry.id, name: facts.resolvedName, icon: facts.iconDataUrl ?? null, optionsUrl: optionsPageUrl(entry.id, manifestOf(entry.id)) }
      }))
    },
    isEnabled: (id) => ctx.extensions()?.list().some((entry) => entry.id === id && entry.enabled) === true,
    optionsUrl: (id) => optionsPageUrl(id, manifestOf(id)),
    actions: (tabId) => {
      const host = hostOfTab(tabId === undefined ? undefined : ctx.tab(tabId)?.contents)
      return new Map((host?.listAllActions(tabId) ?? []).map((action) => [action.id, { hasPopup: action.hasPopup, badge: action.badge }]))
    },
    prefs: ctx.prefs,
    activate: (id, tab, anchor) => { hostOfTab(tab)?.activateAction(id, tab, anchor) },
    canActivate: (tab) => ctx.hostFor(tab.session) !== undefined,
    isLoaded,
    uninstall: async (id) => { await ctx.extensions()?.uninstall(id) }
  })
}

export const actionUserSettingsApi: ExtensionApiModule = { name: 'action-user-settings', install }

/** Called once the shell's services exist: a changed `extensions.pinNew` moves every extension that follows it, in every library instance. */
export function watchPinSetting (services: ShellServices): void {
  services.settings.onChange(({ key }) => {
    if (key === 'extensions.pinNew') for (const refresh of refreshers) refresh()
  })
}
