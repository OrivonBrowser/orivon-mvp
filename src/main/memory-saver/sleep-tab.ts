// Putting one tab to sleep and waking it. The page is closed and the tab keeps a blank view in its place; its
// history, with each entry's page state, stays in memory on the record and is handed back to the view on waking.
import { showTitleUntilLoaded } from '../session-restore/restored-title.js'
import { boundHistory, rememberOpenedFrom } from '../session-restore/tab-snapshot.js'
import { closeParkedViews } from '../shell/tab-parking.js'
import type { SleepingTab } from '../shell/tab-extra-types.js'
import type { TabRecord } from '../shell/tab-types.js'
import { makeTabView, wireView } from '../shell/tab-view.js'
import type { TabManager } from '../shell/tabs.js'
import { gatherFacts, realEnv } from './sleep-facts.js'
import type { SleepEnv } from './sleep-facts.js'
import { canSleep } from './sleep-rules.js'
import type { SleepVerdict } from './sleep-rules.js'

/** Checks `id` against the rules and, if it may sleep, puts it to sleep. Every caller (the command, the idle sweep,
 * an extension's discard) goes through here, so the rules are one. The answer says why a tab stayed awake. */
export async function sleepTabWhy (tabs: TabManager, id: string, env: SleepEnv = realEnv): Promise<SleepVerdict> {
  const before = tabs.record(id)
  if (before === undefined) return { ok: false, why: 'gone' }
  if (before.sleeping != null) return { ok: false, why: 'asleep' }
  const first = gatherFacts(tabs, id, env)
  if (first === null) return { ok: false, why: 'gone' }
  const early = canSleep({ ...first, unsaved: false })
  if (!early.ok) return early

  const wc = tabs.liveWebContents(id)
  if (wc === undefined) return { ok: false, why: 'gone' }
  const unsaved = await env.unsaved(wc)

  // The answer took a moment: the tab may be in front, loading or gone by now, and the swap reads it as it is.
  const record = tabs.record(id)
  const second = record === before && tabs.liveWebContents(id) === wc ? gatherFacts(tabs, id, env) : null
  if (second === null || record === undefined) return { ok: false, why: 'gone' }
  const verdict = canSleep({ ...second, unsaved })
  if (!verdict.ok) return verdict
  return swapToSleep(tabs, id, record, env) ? { ok: true } : { ok: false, why: 'address' }
}

export async function sleepTab (tabs: TabManager, id: string, env: SleepEnv = realEnv): Promise<boolean> {
  return (await sleepTabWhy(tabs, id, env)).ok
}

function swapToSleep (tabs: TabManager, id: string, record: TabRecord, env: SleepEnv): boolean {
  const oldWc = record.view.webContents
  const entries = oldWc.navigationHistory.getAllEntries()
  const index = oldWc.navigationHistory.getActiveIndex()
  if (entries.length === 0 || index < 0 || index >= entries.length) return false
  // `pageState` stays here: it holds what was typed into forms, and no file or log ever receives the record.
  return putToSleep(tabs, id, record, { url: oldWc.getURL(), title: oldWc.getTitle(), favicon: record.favicon, entries, index, at: env.now() })
}

/** Gives the tab a blank view in place of its page and keeps `kept` on the record, which the chrome reads the tab's
 * address, title and icon from until it wakes. The swap is the one a change of session makes. */
export function putToSleep (tabs: TabManager, id: string, record: TabRecord, kept: SleepingTab): boolean {
  const { host } = record
  if (host.isClosing()) return false
  const oldView = record.view
  const oldWc = oldView.webContents
  record.sleeping = kept
  closeParkedViews(record)
  const blank = makeTabView(host.preloadPath, undefined)
  record.view = blank
  record.partition = undefined
  wireView(id, record)
  host.tabLifecycle?.viewReplaced(oldWc, blank.webContents, host.window)
  // The record shows the new view first: the old one's handlers then ignore it, so closing it cannot forget the tab.
  host.devtools?.closeFor(oldWc)
  if (!oldWc.isDestroyed()) oldWc.close()
  tabs.changed()
  return true
}

/** The tab menu's Reload: a sleeping tab's view never loaded a page to reload, so it wakes instead. */
export function reloadOrWake (tabs: TabManager, id: string): void {
  if (tabs.record(id)?.sleeping != null) wakeTab(tabs, id)
  else tabs.reload(id)
}

/** Brings a sleeping tab back on the view it has now: its history returns and its page loads, scrolled and filled as
 * it was. A tab that is not asleep is left alone. */
export function wakeTab (tabs: TabManager, id: string): void {
  const record = tabs.record(id)
  const wc = tabs.liveWebContents(id)
  const kept = record?.sleeping
  if (record === undefined || wc === undefined || kept == null) return
  record.sleeping = null
  showTitleUntilLoaded(record, kept.title)
  // The view has no address until its first commit, so the session file and the closed-tab stack read what the tab was.
  rememberOpenedFrom(record, { url: kept.url, title: kept.title, pinned: record.pinned === true, ...boundHistory(kept.entries.map(({ url, title }) => ({ url, title })), kept.index) })
  const load = (): void => { void wc.loadURL(kept.url).catch(() => {}) }
  try {
    // A restore that is refused after it started (a download, a cancelled navigation) leaves the view blank: load the address instead.
    wc.navigationHistory.restore({ entries: kept.entries, index: kept.index }).catch(() => {
      if (!wc.isDestroyed() && wc.getURL() === '') load()
    })
  } catch {
    // A list the page no longer accepts still leaves the tab on its address.
    load()
  }
  tabs.changed()
}
