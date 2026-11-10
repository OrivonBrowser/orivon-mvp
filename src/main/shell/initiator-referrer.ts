// Tied to Electron through the tab's `WebContents` and the main process's IPC. Keeps, for each tab, what its top frame said
// about the navigation it last started, and combines it with the document's response header when the shell has to re-issue
// that navigation in another session (./navigation-referrer.ts).
import { ipcMain } from 'electron'
import type { WebContents } from 'electron'
import { carriesNoBody, parseReport, referrerFor } from './navigation-referrer.js'
import type { NavigationReferrer, NavigationReport } from './navigation-referrer.js'
import { referrerPolicyHeaderOf } from './page-referrer-policy.js'
import type { ShellInstaller } from './shell-installers.js'

/** What the top frame's preload sends as a navigation begins (`../../preload/navigation-source.ts` holds the same name; a unit test keeps the two equal). */
export const NAVIGATION_NOTE_CHANNEL = 'orivon-navigation:note'

/** The latest note of each tab. A note about another navigation or another document is ignored when it is used, so a stale one costs nothing. */
const notes = new WeakMap<WebContents, NavigationReport>()

/** What a navigation event names of the frame that started it: only the top frame has the preload that sends the note. */
export interface InitiatorFrame {
  readonly url: string
  readonly parent: object | null
}

/** The address of the initiating document when the top frame started the navigation, which is the only one asked about. */
export function topInitiatorUrl (initiator: InitiatorFrame | null | undefined): string | undefined {
  return initiator === null || initiator === undefined || initiator.parent !== null ? undefined : initiator.url
}

/** Keeps the note a tab's top frame sent; anything else, or anything malformed, is dropped: the renderer is not trusted to send the shape. */
export function takeNavigationNote (sender: WebContents, senderFrame: unknown, payload: unknown): void {
  // A subframe has no preload that sends this: a message from one is not from this shell's own script.
  if (senderFrame === null || senderFrame === undefined || senderFrame !== sender.mainFrame) return
  const report = parseReport(payload)
  if (report !== undefined) notes.set(sender, report)
}

export const installNavigationNotes: ShellInstaller = {
  name: 'navigation-notes',
  install: () => {
    ipcMain.on(NAVIGATION_NOTE_CHANNEL, (event, payload: unknown) => { takeNavigationNote(event.sender, event.senderFrame, payload) })
  }
}

/**
 * The referrer for loading `target` in the tab `wc` in place of the navigation its top frame (at `initiatorUrl`) started, or
 * undefined to send none: no top-frame initiator, no note about this navigation, or a policy that cannot be told.
 */
export function referrerOfInitiator (wc: WebContents, initiatorUrl: string | undefined, target: string): NavigationReferrer | undefined {
  if (initiatorUrl === undefined) return undefined
  const report = notes.get(wc)
  if (report === undefined) return undefined
  try {
    return referrerFor(initiatorUrl, target, report, referrerPolicyHeaderOf(wc, report.documentUrl))
  } catch {
    return undefined
  }
}

/**
 * Whether the navigation the top frame (at `initiatorUrl`) started to `target` is known to carry no body, so that loading
 * `target` again as a plain GET is the same navigation. False for a redirect, a navigation no top frame started, and one the
 * page did not report.
 */
export function startedWithoutBody (wc: WebContents, initiatorUrl: string | undefined, target: string): boolean {
  return initiatorUrl !== undefined && carriesNoBody(initiatorUrl, target, notes.get(wc))
}
