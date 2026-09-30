// One window's find bar: which tab it searches, each tab's session, and what
// to do with an answer, a navigation or a close. The bar's tab is always the
// window's active tab, resolved here; the page never names one.
import type { WebContents } from 'electron'
import type { OverlayCloseReason, OverlayHandler, OverlayWindow } from '../overlays/overlay-types.js'
import type { ShellWindow } from '../shell/window-registry.js'
import { asFindRequest, asShowStep } from './find-events.js'
import type { FindEvent, FindShown } from './find-events.js'
import { runFind, selectedText, stopFind } from './find-runner.js'
import { acceptResult, beginCall, invalidate, newSession, stepCall } from './find-session.js'
import type { FindSession, FoundInPage } from './find-session.js'

export const FIND_OVERLAY = 'find'

export interface FindWindow {
  readonly handler: OverlayHandler
  /** An answer from a tab's page. */
  result: (wc: WebContents, found: FoundInPage) => void
  /** The tab's page began or finished loading a document. */
  loading: (wc: WebContents, phase: 'start' | 'stop') => void
  /** The next or previous match of the open bar. */
  step: (forward: boolean) => void
}

const windows = new WeakMap<ShellWindow, FindWindow>()

/** The find bar state of a window, once the bar has been shown in it. */
export function findWindowFor (window: ShellWindow): FindWindow | undefined {
  return windows.get(window)
}

export function createFindWindow (win: OverlayWindow): FindWindow {
  const { window, services } = win
  const sessions = new Map<string, FindSession>()
  /** The last query of this window, for the next open. Never stored. */
  const last = { query: '', matchCase: false }
  /** The tab the open bar searches, or null when it is closed. */
  let barTab: string | null = null

  const activeTab = (): { id: string, wc: WebContents } | undefined => {
    const id = window.tabs.getState().activeTabId
    const wc = id === null ? undefined : window.tabs.liveWebContents(id)
    return id === null || wc === undefined ? undefined : { id, wc }
  }
  const isOpen = (): boolean => window.overlays.isOpen(FIND_OVERLAY)
  const emit = (event: FindEvent): void => { win.send(event) }

  function search (session: FindSession, wc: WebContents, text: string, matchCase: boolean): void {
    last.query = text
    last.matchCase = matchCase
    if (text === '') {
      session.query = ''
      session.matchCase = matchCase
      session.started = false
      session.active = 0
      session.total = 0
      stopFind(wc, false)
      return
    }
    session.requestId = runFind(wc, beginCall(session, text, matchCase))
  }

  function step (forward: boolean): void {
    const tab = activeTab()
    const session = tab === undefined ? undefined : sessions.get(tab.id)
    if (tab === undefined || session === undefined || tab.id !== barTab) return
    const call = stepCall(session, forward)
    if (call !== null) session.requestId = runFind(tab.wc, call)
  }

  async function show (payload: unknown): Promise<FindShown> {
    const tab = activeTab()
    if (tab === undefined) return { query: '', matchCase: false, fresh: true }
    const existing = sessions.get(tab.id)
    // Opened again while open: it only takes focus back and selects its text.
    if (barTab === tab.id && existing !== undefined) return { query: existing.query, matchCase: existing.matchCase, fresh: false }
    const session = existing ?? newSession()
    sessions.set(tab.id, session)
    barTab = tab.id
    const returning = session.reopen
    session.reopen = false
    const picked = returning || last.query !== '' ? '' : await selectedText(tab.wc)
    // The bar may have been closed, or the tab left, while the page answered.
    if (barTab !== tab.id) return { query: '', matchCase: false, fresh: true }
    const query = returning ? session.query : picked !== '' ? picked : last.query
    const matchCase = returning ? session.matchCase : last.matchCase
    const stepAfter = asShowStep(payload)
    if (query !== '') {
      search(session, tab.wc, query, matchCase)
      session.pendingStep = stepAfter ?? null
    } else {
      session.query = ''
      session.matchCase = matchCase
    }
    return { query, matchCase, fresh: true }
  }

  function request (command: unknown): void {
    const asked = asFindRequest(command)
    const tab = activeTab()
    if (asked === undefined || tab === undefined || tab.id !== barTab) return
    if (asked.type === 'step') { step(asked.forward); return }
    const session = sessions.get(tab.id) ?? newSession()
    sessions.set(tab.id, session)
    search(session, tab.wc, asked.text, asked.matchCase)
  }

  function closed (reason: OverlayCloseReason): void {
    const id = barTab
    barTab = null
    if (reason === 'window-closed') { sessions.clear(); return }
    if (id === null) return
    const session = sessions.get(id)
    const wc = window.tabs.liveWebContents(id)
    if (reason === 'tab-switch') {
      stopFind(wc, false)
      if (session !== undefined) { invalidate(session); session.reopen = session.query !== '' }
      return
    }
    // Escape and the close button leave the active match selected on the page.
    stopFind(wc, reason === 'escape' || reason === 'request')
    sessions.delete(id)
  }

  function result (wc: WebContents, found: FoundInPage): void {
    const id = window.tabs.findTabIdByWebContents(wc)
    const session = id === null ? undefined : sessions.get(id)
    if (id === null || session === undefined || id !== barTab || !isOpen()) return
    const accepted = acceptResult(session, found)
    if (accepted === null) return
    emit({ type: 'result', active: accepted.active, total: accepted.total })
    const pending = session.pendingStep
    session.pendingStep = null
    if (pending !== null && accepted.total > 1) step(pending)
  }

  function loading (wc: WebContents, phase: 'start' | 'stop'): void {
    const id = window.tabs.findTabIdByWebContents(wc)
    const session = id === null ? undefined : sessions.get(id)
    if (id === null || session === undefined || id !== barTab || !isOpen()) return
    if (phase === 'start') {
      invalidate(session)
      emit({ type: 'reset' })
    } else if (session.query !== '') {
      search(session, wc, session.query, session.matchCase)
    }
  }

  // A tab that had the bar when it was left gets it back with its query. It waits one turn: the switch that
  // closed the bar of the tab being left is still in progress when the new tab is announced.
  const unsubscribe = services.tabLifecycle.subscribe({
    tabActivated: (contents) => {
      if (window.window.isDestroyed()) { unsubscribe(); return }
      const id = window.tabs.findTabIdByWebContents(contents)
      if (id === null || sessions.get(id)?.reopen !== true) return
      setTimeout(() => {
        if (!window.window.isDestroyed() && window.tabs.getState().activeTabId === id && !isOpen()) window.overlays.show(FIND_OVERLAY)
      }, 0)
    },
    tabClosing: ({ id }) => { sessions.delete(id) }
  })

  const findWindow: FindWindow = {
    handler: {
      show: async (payload) => await show(payload),
      request,
      closed
    },
    result,
    loading,
    step
  }
  windows.set(window, findWindow)
  return findWindow
}
