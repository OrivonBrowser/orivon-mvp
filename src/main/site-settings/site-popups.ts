// The process-wide pop-up blocker and the two records it keeps: what each tab's
// page tried to open, and when the person last gave each tab input. One of
// each, as `page-access.ts` has one record: every window's tabs read the same.
// `tab-view.ts` asks `sitePopups.check` from the window-open handler without
// holding a store or a window.
import type { WebContents } from 'electron'
import { PopupBlocks } from './popup-blocks.js'
import type { PopupBlocker } from './popup-blocker.js'
import { TabInteraction } from './tab-interaction.js'

export const popupBlocks = new PopupBlocks<WebContents>()
export const tabInteraction = new TabInteraction<WebContents>()

let blocker: PopupBlocker<WebContents> | undefined

export const sitePopups = {
  bind (next: PopupBlocker<WebContents>): void { blocker = next },
  /** True when the open is refused; false before the installer ran, so nothing is blocked then. */
  check (tab: WebContents, openerUrl: string, targetUrl: string): boolean {
    return blocker?.check(tab, openerUrl, targetUrl) ?? false
  },
  watch (tab: WebContents): void { blocker?.watch(tab) }
}
