// Pinning, acted on: which actions the toolbar list shows, what
// `chrome.action.getUserSettings` answers, the `onUserSettingsChanged` event,
// the right-click menu of a toolbar action, and the dependencies the
// Extensions menu overlay reads. An API module so it runs once, with the
// router and the host in reach, before the first extension loads.
import { setActionMenuBuilder, setActionVisibilityCheck } from 'orivon:crx-extensions-browser-action'
import type { ShellServices } from '../shell/shell-services.js'
import type { TabManager } from '../shell/tabs.js'
import { actionMenuTemplate } from './action-context-menu.js'
import type { ExtensionApiContext, ExtensionApiModule } from './api/api-types.js'
import { isPinned } from './action-pins.js'
import { setExtensionsMenuDeps } from './extensions-menu-deps.js'
import { optionsPageUrl } from './extensions-menu-model.js'
import { extensionOpenedUrl } from './extension-url-policy.js'
import { readExtensionFacts } from './extensions-view-runner.js'

const USER_SETTINGS_EVENT = 'action.onUserSettingsChanged'

/** Set once the module has run; `watchPinSetting` needs the same refresh. */
let refreshAll: (() => void) | undefined

function install (ctx: ExtensionApiContext): void {
  const pinNew = (): boolean => ctx.shell()?.settings.get('extensions.pinNew') ?? true
  const pinned = (id: string): boolean => isPinned(ctx.prefs.get(id), pinNew())
  /** What each extension was last known to show, so only a real change is told to it. */
  const known = new Map<string, boolean>()

  setActionVisibilityCheck((id) => {
    const now = pinned(id)
    known.set(id, now)
    return now
  })

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
  ctx.prefs.onChange((id) => { refresh([id]) })
  refreshAll = () => { refresh([...known.keys()]) }

  const manifestOf = (id: string): unknown => ctx.session.extensions.getExtension(id)?.manifest
  const isLoaded = (id: string): boolean => ctx.session.extensions.getExtension(id) != null
  const focusedTabs = (): TabManager | undefined => ctx.shell()?.windows.focused()?.tabs

  setActionMenuBuilder((id, extensionItems) => actionMenuTemplate({
    name: ctx.session.extensions.getExtension(id)?.name ?? id,
    hasOptions: optionsPageUrl(id, manifestOf(id)) !== undefined,
    pinned: pinned(id),
    extensionItems,
    openOptions: () => {
      const url = optionsPageUrl(id, manifestOf(id))
      const target = url === undefined ? undefined : extensionOpenedUrl(url, isLoaded)
      if (target !== undefined) focusedTabs()?.openTrusted(target)
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
    actions: (tabId) => new Map(ctx.host.listAllActions(tabId).map((action) => [action.id, { hasPopup: action.hasPopup, badge: action.badge }])),
    prefs: ctx.prefs,
    activate: (id, tab, anchor) => { ctx.host.activateAction(id, tab, anchor) },
    canActivate: (tab) => tab.session === ctx.session,
    isLoaded,
    uninstall: async (id) => { await ctx.extensions()?.uninstall(id) }
  })
}

export const actionUserSettingsApi: ExtensionApiModule = { name: 'action-user-settings', install }

/** Called once the shell's services exist: a changed `extensions.pinNew` moves every extension that follows it. */
export function watchPinSetting (services: ShellServices): void {
  services.settings.onChange(({ key }) => { if (key === 'extensions.pinNew') refreshAll?.() })
}
