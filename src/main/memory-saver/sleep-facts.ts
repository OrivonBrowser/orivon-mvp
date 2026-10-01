// What the sleep rules read, gathered from a live tab. Split from sleep-tab.ts so the swap stays about the swap.
import type { WebContents } from 'electron'
import { hasAsk } from '../overlays/tab-slots.js'
import { appTabViews } from '../shell/tab-partition.js'
import type { TabRecord } from '../shell/tab-types.js'
import type { TabManager } from '../shell/tabs.js'
import { mediaInUse } from './media-in-use.js'
import { hostKept } from './sleep-rules.js'
import type { SleepFacts } from './sleep-rules.js'
import { holdsUnsavedInput } from './unsaved-input.js'

declare const __ORIVON_DEV_GRANT_ENABLED__: boolean | undefined
const SEAM_ENABLED = typeof __ORIVON_DEV_GRANT_ENABLED__ !== 'undefined' && __ORIVON_DEV_GRANT_ENABLED__ === true

declare global {
  // Test builds only: a driven browser counts every page as captured, so a test turns the capture rule off to reach
  // the others. `var` because a `declare global` augmentation needs it.
  var __orivonSleepIgnoreCapture: boolean | undefined
}

/** Whether a page is being captured, by Chromium's own count. */
function beingCaptured (wc: WebContents): boolean {
  if (SEAM_ENABLED && globalThis.__orivonSleepIgnoreCapture === true) return false
  return wc.isBeingCaptured()
}

/** The few things the facts need from outside the tab, so a test can stand them in. */
export interface SleepEnv {
  now: () => number
  /** A prompt, sign-in or chooser is shown or queued for the tab. */
  hasAsk: (record: TabRecord, id: string) => boolean
  mediaInUse: (wc: WebContents) => boolean
  /** `performance.keepAwake`, one site a line. */
  keepAwakeList: (record: TabRecord) => string
  unsaved: (wc: WebContents) => Promise<boolean>
}

export const realEnv: SleepEnv = {
  now: () => Date.now(),
  hasAsk: (record, id) => {
    const found = record.host.services?.windows.findTab(record.view.webContents)
    return found !== undefined && found !== null && found.tabId === id && hasAsk(found.window, id)
  },
  mediaInUse: (wc) => mediaInUse(wc),
  keepAwakeList: (record) => {
    const list = record.host.services?.settings.get('performance.keepAwake')
    return typeof list === 'string' ? list : ''
  },
  unsaved: async (wc) => await holdsUnsavedInput(wc)
}

function hostnameOf (url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/** Only a page that a plain load brings back: an address the shell opens in an ordinary tab. */
function restorable (url: string): boolean {
  return url.startsWith('https://') || url.startsWith('http://')
}

/** Every fact but `unsaved`, which costs a round trip to the page and is asked only of a tab nothing else keeps awake. */
/** `address` stands in for the page's own when the page has not committed one yet (a tab being restored). */
export function gatherFacts (tabs: TabManager, id: string, env: SleepEnv, address?: string): Omit<SleepFacts, 'unsaved'> | null {
  const record = tabs.record(id)
  const wc = tabs.liveWebContents(id)
  if (record === undefined || wc === undefined) return null
  const url = address ?? wc.getURL()
  const activeId = tabs.getState().activeTabId
  return {
    active: activeId === id || record.host.isShown(id),
    splitPartner: activeId !== null && tabs.splits.groups.partnerOf(activeId) === id,
    pinned: record.pinned === true,
    audible: wc.isCurrentlyAudible(),
    capturing: beingCaptured(wc),
    mediaInUse: env.mediaInUse(wc),
    pendingAsk: env.hasAsk(record, id),
    crashed: record.crashed != null || wc.isCrashed(),
    devtools: wc.isDevToolsOpened(),
    newTab: record.isDashboardTab || url === '' || url === 'about:blank',
    internal: record.internalPage !== null || record.reader != null || url.startsWith('orivon:'),
    app: appTabViews.has(record.view),
    partitioned: record.partition !== undefined,
    loading: wc.isLoading(),
    unrestorable: !restorable(url),
    keepAwakeHost: hostKept(hostnameOf(url), env.keepAwakeList(record))
  }
}
