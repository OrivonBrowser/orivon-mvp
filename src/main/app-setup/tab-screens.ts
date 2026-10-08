// What one tab shows while an app's first visit runs (ADR-0074): the cover with the stage's words, then a
// sheet when the app was not opened, over a tab whose page has not been allowed to run. Follows the tab
// itself: another navigation or its destruction ends the visit's screens at once.
import type { WebContents } from 'electron'
import { LOADING_SCREEN_OVERLAY } from '../loading-screen/loading-screen-watch.js'
import { claimCover } from '../loading-screen/claim.js'
import type { requestSlot } from '../overlays/tab-slots.js'
import type { SetupSheet, SetupStage } from '../install/first-visit.js'
import type { ShellWindow } from '../shell/window-registry.js'
import { awaitSheetAnswer, SETUP_SHEET_OVERLAY } from './setup-sheet-overlay.js'
import type { SheetChoice } from './setup-sheet-overlay.js'
import { coverFor, sheetView } from './setup-text.js'
import type { CoverState } from './setup-text.js'

export interface TabScreens {
  show: (stage: SetupStage) => void
  /** Resolves what the person chose; `leave` too when the sheet went away without an answer. */
  sheet: (sheet: SetupSheet) => Promise<SheetChoice>
  /** Takes every screen of this visit away. Idempotent. */
  end: () => void
  /** The tab started another navigation or was destroyed: whatever was asked of it is no longer about this page. */
  moved: () => boolean
  /** The tab goes to `url` through the address bar's own path, which puts it in the session an app of that address runs in. */
  navigate: (url: string) => void
  /** The tab leaves its page: back when it can, else home. */
  leavePage: () => void
}

/** The screens for `contents`' visit to `address`, or undefined for a web contents no window holds as a tab. */
export type TabSetup = (contents: WebContents, address: string) => TabScreens | undefined

export interface TabSetupDeps {
  readonly findTab: (contents: WebContents) => { window: ShellWindow, tabId: string } | null
  readonly ask: typeof requestSlot
  /** Builds the cover's view ahead of its show. */
  readonly prewarm: (window: ShellWindow) => void
  readonly newToken: () => string
  readonly navigate: (window: ShellWindow, tabId: string, url: string) => void
  readonly leavePage: (window: ShellWindow, tabId: string) => void
}

export function createTabSetup (deps: TabSetupDeps): TabSetup {
  return (contents, address) => {
    const found = deps.findTab(contents)
    if (found === null) return undefined
    const { window, tabId } = found
    let ended = false
    let moved = false
    let cover: { cancel: () => void } | undefined
    let sheet: { cancel: () => void } | undefined
    let release: (() => void) | undefined
    let forgetAnswer: (() => void) | undefined
    let settleSheet: ((choice: SheetChoice) => void) | undefined

    const askCover = (state: CoverState): void => {
      if (ended) return
      release ??= claimCover(contents)
      deps.prewarm(window)
      const text = coverFor(state)
      const mine = deps.ask({ window, tabId, slot: 'cover', overlay: LOADING_SCREEN_OVERLAY, payload: { url: address, text }, closed: () => { if (cover === mine) cover = undefined } })
      cover = mine
    }

    const end = (): void => {
      if (ended) return
      ended = true
      contents.removeListener('did-start-navigation', onNavigation)
      contents.removeListener('destroyed', onDestroyed)
      settleSheet?.('leave')
      sheet?.cancel()
      cover?.cancel()
      sheet = cover = undefined
      forgetAnswer?.()
      release?.()
    }

    const moveOn = (): void => {
      moved = true
      end()
    }
    const onNavigation = (details: { isMainFrame: boolean, isSameDocument: boolean }): void => {
      if (details.isMainFrame && !details.isSameDocument) moveOn()
    }
    const onDestroyed = (): void => { moveOn() }
    contents.on('did-start-navigation', onNavigation as never)
    contents.on('destroyed', onDestroyed)

    return {
      show: (stage) => { askCover(stage) },
      sheet: async (shown) => {
        if (ended) return 'leave'
        askCover({ kind: shown.kind, name: shown.name })
        const token = deps.newToken()
        return await new Promise<SheetChoice>((resolve) => {
          settleSheet = (choice) => { settleSheet = undefined; resolve(choice) }
          forgetAnswer = awaitSheetAnswer(token, (choice) => {
            settleSheet?.(choice)
            sheet?.cancel()
          })
          const mine = deps.ask({
            window, tabId, slot: 'center', overlay: SETUP_SHEET_OVERLAY, payload: sheetView(shown, address, token),
            closed: () => { if (sheet === mine) sheet = undefined; forgetAnswer?.(); settleSheet?.('leave') }
          })
          sheet = mine
        })
      },
      end,
      moved: () => moved,
      navigate: (url) => { deps.navigate(window, tabId, url) },
      leavePage: () => { deps.leavePage(window, tabId) }
    }
  }
}
