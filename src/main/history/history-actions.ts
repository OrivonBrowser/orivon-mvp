// What the History page asks for by the id of a row it shows: open it, copy it, bring back a closed tab. The page
// never names an address, so none is ever opened on its say-so; each is read from the history here.
import { BUILTIN_ADDRESSES } from '../../protocols/builtin.js'
import { sanitizeBrowserUrl } from '../browsing/local-file-input.js'
import type { CommandBus } from '../shortcuts/command-bus.js'
import type { ClosedEntry, ClosedStack } from '../session-restore/closed-stack.js'
import { navigateFromBrowser, openFromBrowser } from '../shell/open-from-browser.js'
import { cascadeFrom } from '../shell/window-options.js'
import type { ShellWindow, WindowRegistry } from '../shell/window-registry.js'
import type { InternalCaller } from '../pages/internal-ipc.js'
import { faviconHost } from './favicon-host.js'
import type { HistoryService } from './history-service.js'

export interface HistoryActionDeps {
  readonly windows: Pick<WindowRegistry, 'findTab'>
  readonly commands: Pick<CommandBus, 'openWindow' | 'reopen'>
  readonly closedTabs: Pick<ClosedStack, 'list'>
  readonly copyText: (text: string) => void
}

const DISPOSITIONS = ['tab', 'newTab', 'background', 'window'] as const
export type Disposition = typeof DISPOSITIONS[number]

/** The most rows one open-all call opens. */
export const MAX_OPEN_MANY = 20
/** The most recently closed tabs the page lists. */
export const MAX_CLOSED_ROWS = 8

const isIds = (value: unknown, max: number): value is number[] => Array.isArray(value) && value.length <= max && value.every((id) => Number.isInteger(id))

function openAll (urls: readonly string[], disposition: Disposition, caller: InternalCaller, deps: HistoryActionDeps): void {
  const found = deps.windows.findTab(caller.contents)
  if (found === null || urls.length === 0) return
  const { window: shell, tabId } = found
  switch (disposition) {
    case 'tab':
      void navigateFromBrowser(shell.tabs, tabId, urls[0] as string)
      for (const url of urls.slice(1)) openFromBrowser(shell.tabs, url, false)
      return
    case 'newTab':
      for (const url of urls) openFromBrowser(shell.tabs, url, url === urls[0])
      return
    case 'background':
      for (const url of urls) openFromBrowser(shell.tabs, url, false)
      return
    case 'window':
      deps.commands.openWindow({ place: cascadeFrom(shell.window.getBounds()), first: (tabs) => { for (const url of urls) openFromBrowser(tabs, url) } })
  }
}

/** The addresses of the pages with these ids that a tab may open. */
function addressesOf (history: HistoryService, ids: readonly number[]): string[] {
  return history.pagesByIds(ids).map((page) => page.url).filter((url) => sanitizeBrowserUrl(url) !== null)
}

function closedRow (entry: ClosedEntry, icons: Readonly<Record<string, string>>): object {
  if (entry.kind === 'window') {
    const { tabs } = entry.window
    const first = tabs[0]
    return { id: entry.id, kind: 'window', title: '', address: tabs.slice(0, 3).map((tab) => tab.title || tab.url).join(', '), tabs: tabs.length, at: entry.at, favicon: icons[faviconHost(first?.url ?? '') ?? ''] ?? null }
  }
  const address = BUILTIN_ADDRESSES.displayUrl(entry.tab.url)
  return { id: entry.id, kind: 'tab', title: entry.tab.title, address, tabs: 1, at: entry.at, favicon: icons[faviconHost(address) ?? ''] ?? null }
}

/** Handles one of the page's id-based requests; `undefined` for a request that is not one, or is malformed. */
export function handleHistoryAction (request: { type?: unknown, id?: unknown, ids?: unknown, disposition?: unknown }, caller: InternalCaller, history: HistoryService, deps: HistoryActionDeps): unknown {
  switch (request.type) {
    case 'open': {
      const disposition = DISPOSITIONS.find((candidate) => candidate === request.disposition)
      if (!Number.isInteger(request.id) || disposition === undefined) return undefined
      openAll(addressesOf(history, [request.id as number]), disposition, caller, deps)
      return { ok: true }
    }
    case 'openMany':
      if (!isIds(request.ids, MAX_OPEN_MANY)) return undefined
      openAll(addressesOf(history, request.ids), 'background', caller, deps)
      return { ok: true }
    case 'copy': {
      if (!Number.isInteger(request.id)) return undefined
      const [page] = history.pagesByIds([request.id as number])
      if (page !== undefined) deps.copyText(page.url)
      return { ok: true }
    }
    case 'closed': {
      const entries = deps.closedTabs.list().slice(0, MAX_CLOSED_ROWS)
      const hosts = entries.flatMap((entry) => faviconHost(entry.kind === 'tab' ? BUILTIN_ADDRESSES.displayUrl(entry.tab.url) : entry.window.tabs[0]?.url ?? '') ?? [])
      const icons = history.faviconsFor(hosts)
      return { rows: entries.map((entry) => closedRow(entry, icons)) }
    }
    case 'reopen': {
      if (!Number.isInteger(request.id)) return undefined
      const entry = deps.closedTabs.list().find((candidate) => candidate.id === request.id)
      const target: ShellWindow | undefined = deps.windows.findTab(caller.contents)?.window
      if (entry === undefined || target === undefined) return { result: 'gone' }
      return { result: deps.commands.reopen(entry, target) ?? 'gone' }
    }
    default:
      return undefined
  }
}
