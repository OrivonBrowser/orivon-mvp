// The suggestions of one window: what its service reads from the shell's stores, and where a slow source's
// rows are sent. A window has one service, made on the first query and kept as long as the window.
import { parseOmniboxInput } from '../browsing/omnibox.js'
import { SEARCH_ENGINES, searchUrlFor } from '../browsing/search-engines.js'
import { isDevEthName } from '../dev/eth-resolver.js'
import { parseInternalUrl } from '../pages/internal-pages.js'
import type { WindowContext } from '../shell/window-context.js'
import type { ShellWindow } from '../shell/window-registry.js'
import { OMNIBOX_OVERLAY } from './omnibox-names.js'
import { OmniboxService } from './omnibox-service.js'
import type { OmniboxDeps } from './omnibox-service.js'
import type { SuggestTab } from './suggest-sources.js'
import { verbatimRow } from './verbatim-row.js'

const services = new WeakMap<ShellWindow, OmniboxService>()

/** Every open tab of every window of this process, for "Switch to this tab". */
function openTabs ({ window, services: shell }: WindowContext): SuggestTab[] {
  const found: SuggestTab[] = []
  for (const entry of shell.windows.all()) {
    if (entry.window.isDestroyed()) continue
    const { tabs, activeTabId } = entry.tabs.getState()
    for (const tab of tabs) {
      found.push({
        id: tab.id, title: tab.title, url: tab.url, displayUrl: tab.displayUrl, favicon: tab.favicon,
        current: entry === window && tab.id === activeTabId, blank: tab.isNewTab
      })
    }
  }
  return found
}

function depsFor (ctx: WindowContext): OmniboxDeps {
  const { window, services: shell } = ctx
  const searchUrl = (query: string): string => searchUrlFor(shell.settings.get('search.engine'), shell.settings.get('search.customUrl'), query)
  const classify = (text: string): ReturnType<typeof parseOmniboxInput> => parseOmniboxInput(text, isDevEthName, searchUrl)
  return {
    context: () => ({
      now: Date.now(),
      isPrivate: shell.isPrivate,
      history: shell.history,
      bookmarks: () => shell.bookmarks.getAll(),
      tabs: () => openTabs(ctx)
    }),
    verbatim: (text) => verbatimRow(text, {
      classify,
      isInternal: (candidate) => parseInternalUrl(candidate) !== null,
      engineName: SEARCH_ENGINES.find((engine) => engine.id === shell.settings.get('search.engine'))?.label ?? ''
    }),
    autocomplete: () => shell.settings.get('addressBar.autocomplete'),
    resolve: (text) => {
      const result = classify(text)
      return result.kind === 'reject' ? null : result.url
    },
    faviconsFor: (hosts) => shell.history.faviconsFor(hosts),
    onLate: (snapshot) => { window.overlays.send(OMNIBOX_OVERLAY, { type: 'rows', ...snapshot }) }
  }
}

export function omniboxFor (ctx: WindowContext): OmniboxService {
  let service = services.get(ctx.window)
  if (service === undefined) {
    service = new OmniboxService(depsFor(ctx))
    services.set(ctx.window, service)
  }
  return service
}

/** The window's service if a query has made one. */
export function existingOmnibox (window: ShellWindow): OmniboxService | undefined {
  return services.get(window)
}
