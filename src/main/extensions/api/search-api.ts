// chrome.search.query: opens the default engine's results for a text, as typing it in the address bar
// would. The URL comes from the engine code (`searchUrlFor`), which encodes the text; nothing is
// concatenated here. A tab the call names must be an ordinary web tab: an app's tab or an Orivon page
// is not one an extension can send anywhere.
import type { WebContents } from 'electron'
import { searchUrlFor } from '../../browsing/search-engines.js'
import type { ApiEvent, ExtensionApiContext, ExtensionApiModule } from './api-types.js'

export const MAX_SEARCH_TEXT = 2000
export const BOTH_ERROR = "Cannot set both 'disposition' and 'tabId'."
const DISPOSITIONS = ['CURRENT_TAB', 'NEW_TAB', 'NEW_WINDOW'] as const
type Disposition = typeof DISPOSITIONS[number]

function fail (message: string): never { throw new Error(message) }

interface Request { readonly text: string, readonly disposition: Disposition | undefined, readonly tabId: number | undefined }

export function parseQuery (properties: unknown): Request {
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) return fail('Invalid argument: the query must be an object.')
  const given = properties as Record<string, unknown>
  const { text, disposition, tabId } = given
  if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_SEARCH_TEXT) {
    return fail(`Invalid argument: text must be a non-empty string of at most ${String(MAX_SEARCH_TEXT)} characters.`)
  }
  if (disposition !== undefined && tabId !== undefined) return fail(BOTH_ERROR)
  if (disposition !== undefined && !(DISPOSITIONS as readonly unknown[]).includes(disposition)) {
    return fail("Invalid argument: disposition must be 'CURRENT_TAB', 'NEW_TAB' or 'NEW_WINDOW'.")
  }
  if (tabId !== undefined && (typeof tabId !== 'number' || !Number.isInteger(tabId))) return fail('Invalid argument: tabId must be an integer.')
  return { text, disposition: disposition as Disposition | undefined, tabId: tabId as number | undefined }
}

export function installSearch (ctx: ExtensionApiContext): void {
  ctx.handle('search.query', (event: ApiEvent, properties) => {
    const { text, disposition, tabId } = parseQuery(properties)
    const shell = ctx.shell() ?? fail('Search is not available yet.')
    const url = searchUrlFor(shell.settings.get('search.engine'), shell.settings.get('search.customUrl'), text)
    const ordinary = (contents: WebContents): boolean => !ctx.isAppOrigin(contents.getURL()) && shell.internalPages.pageOf(contents) === undefined

    if (tabId !== undefined) {
      const found = ctx.tab(tabId)
      if (found === undefined || !ordinary(found.contents)) return fail(`No tab with id: ${String(tabId)}.`)
      found.window.tabs.navigate(found.id, url)
      return
    }
    const caller = ctx.callerWindow(event)
    const target = caller ?? shell.windows.focused()
    if (disposition === 'NEW_WINDOW' || target === undefined) {
      shell.commands.openWindow({ first: (tabs) => { tabs.createTab(url) } })
      return
    }
    if (disposition === 'NEW_TAB') {
      target.tabs.createTab(url)
      return
    }
    const current = ctx.activeTab(caller?.window.id)
    if (current !== undefined && ordinary(current.contents)) current.window.tabs.navigate(current.id, url)
    else target.tabs.createTab(url)
  })
}

export const searchApi: ExtensionApiModule = {
  name: 'search',
  permission: 'search',
  install: (ctx) => { installSearch(ctx) }
}
