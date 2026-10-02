// The one overlay behind both surfaces a site's permissions have: the
// question under the address bar ("ask"), and the bubble under the chip that
// lists what this page was asked and lets the person change it ("review").
// The page sends a few fixed words; the site, the kinds and the tab are
// always read here, in main, never taken from the page.
import { originFromUrl } from '../../broker/policy/origin.js'
import { createKeyQuiet } from '../overlays/key-quiet.js'
import type { OverlayDef, OverlayHandler, OverlayWindow } from '../overlays/overlay-types.js'
import { slotClosed } from '../overlays/tab-slots.js'
import { commandById } from '../shortcuts/commands.js'
import { pendingAsk, SITE_PROMPT_OVERLAY } from './ask-site.js'
import { siteKindById, type SiteKind, type SiteValue } from './kinds.js'
import { pageAccess, type PageAccess } from './page-access.js'
import { askView, reviewView, type AskView, type ReviewRow, type ReviewView } from './site-prompt-text.js'

const PROMPT_WIDTH = 360

/** An answer is ignored this long after the question appears, so a click or key meant for the page cannot land on it. Enforced here: the page only draws the buttons as not ready. */
export const ANSWER_GUARD_MS = 500

type Current = { mode: 'none' } | { mode: 'ask', id: string } | { mode: 'review', tabId: string }

type Command =
  | { type: 'answer', id: string, answer: 'allow' | 'block' }
  | { type: 'drawn', id: string }
  | { type: 'set', kind: SiteKind, value: SiteValue }
  | { type: 'reload' }
  | { type: 'settings' }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** Only the fixed shapes, with no extra keys: anything else is not a command of this overlay. */
function asCommand (command: unknown): Command | undefined {
  if (!isRecord(command)) return undefined
  const { type, ...rest } = command
  const keys = Object.keys(rest).sort().join(',')
  if ((type === 'reload' || type === 'settings') && keys === '') return { type }
  if (type === 'drawn' && keys === 'id') return typeof rest['id'] === 'string' ? { type, id: rest['id'] } : undefined
  if (type === 'answer' && keys === 'answer,id') {
    const { id, answer } = rest
    return typeof id === 'string' && (answer === 'allow' || answer === 'block') ? { type, id, answer } : undefined
  }
  if (type === 'set' && keys === 'kind,value') {
    const kind = siteKindById(rest['kind'])
    const { value } = rest
    return kind !== undefined && (value === 'ask' || value === 'allow' || value === 'block') ? { type, kind: kind.id, value } : undefined
  }
  return undefined
}

/** The payload of a show: an ask the asker is holding, or the review of the tab in front. */
function asShown (payload: unknown): { mode: 'ask', id: string } | { mode: 'review' } | undefined {
  if (!isRecord(payload)) return undefined
  if (payload['mode'] === 'review' && Object.keys(payload).length === 1) return { mode: 'review' }
  return payload['mode'] === 'ask' && typeof payload['id'] === 'string' ? { mode: 'ask', id: payload['id'] } : undefined
}

export function createSitePrompt ({ window, services, close, send }: OverlayWindow, access: PageAccess<Electron.WebContents> = pageAccess, now: () => number = Date.now): OverlayHandler {
  let current: Current = { mode: 'none' }
  // The guard counts from the page drawing the question, never from the show: the page loads cold, so the show can come long before anything is on screen.
  let shownAt: number | null = null
  // A key typed at the page when the prompt appears must not reach Allow either: the keyboard has to be quiet for the guard's length too.
  const keys = createKeyQuiet(now)
  let stopWatching: (() => void) | undefined

  /** A new document ends the review; a page that only rewrites its own address does not. */
  function closeOnNewDocument (wc: Electron.WebContents): void {
    const onNavigate = (): void => { close() }
    wc.once('did-navigate', onNavigate)
    stopWatching = () => { wc.removeListener('did-navigate', onNavigate) }
  }

  /** The tab the bubble is about, while it is still the one in front and on the page the record describes. */
  function reviewTab (tabId: string): { wc: Electron.WebContents, origin: string } | undefined {
    if (window.tabs.getState().activeTabId !== tabId) return undefined
    const wc = window.tabs.liveWebContents(tabId)
    if (wc === undefined) return undefined
    const origin = access.originOf(wc)
    return origin !== null && originFromUrl(wc.getURL()) === origin ? { wc, origin } : undefined
  }

  function rowsOf (wc: Electron.WebContents, origin: string): ReviewRow[] {
    return access.entries(wc).flatMap(({ kind }): ReviewRow[] => {
      const def = siteKindById(kind)
      if (def === undefined) return []
      const stored = services.siteSettings.get(origin, kind)
      const defaultBlocks = services.settings.get(def.settingKey) === 'block'
      const value: SiteValue = stored ?? (defaultBlocks ? 'block' : 'ask')
      return [{ kind, label: def.label, value, askOffered: !defaultBlocks }]
    })
  }

  return {
    key: keys.onKey,
    show: (payload): AskView | ReviewView | undefined => {
      current = { mode: 'none' }
      stopWatching?.()
      stopWatching = undefined
      shownAt = null
      keys.reset()
      const shown = asShown(payload)
      if (shown?.mode === 'ask') {
        const ask = pendingAsk(shown.id)
        if (ask === undefined || ask.window !== window) return undefined
        current = { mode: 'ask', id: ask.id }
        return askView(ask.id, ask.origin, ask.kinds, ask.sysex, services.isPrivate, ANSWER_GUARD_MS)
      }
      if (shown?.mode === 'review') {
        const tabId = window.tabs.getState().activeTabId
        const tab = tabId === null ? undefined : reviewTab(tabId)
        if (tabId === null || tab === undefined) return undefined
        const rows = rowsOf(tab.wc, tab.origin)
        if (rows.length === 0) return undefined
        current = { mode: 'review', tabId }
        closeOnNewDocument(tab.wc)
        return reviewView(tab.origin, rows, commandById('siteSettings.open')?.pending !== true)
      }
      return undefined
    },

    request: (command) => {
      const asked = asCommand(command)
      if (asked === undefined) return undefined
      if (asked.type === 'drawn') {
        if (current.mode === 'ask' && current.id === asked.id && shownAt === null) shownAt = now()
        return true
      }
      if (asked.type === 'answer') {
        if (current.mode !== 'ask' || current.id !== asked.id) return undefined
        const ask = pendingAsk(asked.id)
        if (ask === undefined || shownAt === null || now() - shownAt < ANSWER_GUARD_MS || keys.quietFor() < ANSWER_GUARD_MS) return undefined
        // The answer first, then the close: closing alone would settle the ask as "not now".
        ask.settle(asked.answer)
        close()
        return undefined
      }
      if (current.mode !== 'review') return undefined
      const tab = reviewTab(current.tabId)
      if (tab === undefined) { close(); return undefined }
      if (asked.type === 'reload') {
        close()
        tab.wc.reload()
      } else if (asked.type === 'settings') {
        if (commandById('siteSettings.open')?.pending === true) return undefined
        close()
        services.commands.run('siteSettings.open', window)
      } else {
        // Only what this page was asked about, on the site it is on now.
        if (!access.entries(tab.wc).some((entry) => entry.kind === asked.kind)) return undefined
        if (asked.value === 'ask') services.siteSettings.forget(tab.origin, asked.kind)
        else {
          services.siteSettings.set(tab.origin, asked.kind, asked.value)
          access.note(tab.wc, tab.origin, asked.kind, asked.value === 'allow' ? 'allowed' : 'blocked')
        }
        return { kind: asked.kind, value: asked.value }
      }
      return undefined
    },

    // A resize moves the question under the person's pointer: the guard starts over.
    moved: () => {
      if (current.mode !== 'ask' || shownAt === null) return
      shownAt = now()
      send({ type: 'arm' })
    },

    closed: (reason) => {
      const was = current
      current = { mode: 'none' }
      stopWatching?.()
      stopWatching = undefined
      // The slot decides what the close means: a tab switch only hides the question, anything else ends it as "not now".
      if (was.mode === 'ask') slotClosed(window, SITE_PROMPT_OVERLAY, reason)
    }
  }
}

export const sitePromptOverlay: OverlayDef = {
  name: SITE_PROMPT_OVERLAY,
  placement: { kind: 'anchor', width: PROMPT_WIDTH, align: 'left' },
  surface: 'panel',
  // Focus goes to the prompt so a key the person types at the page cannot answer it; the page puts it on the dialog, not a button.
  focus: 'take',
  layer: 'bar',
  // A click elsewhere leaves a question open and a tab switch hides it. A new document ends a question in ask-site.ts and a
  // review in the handler; the slot's own navigation close also fires when a page only rewrites its address, which must not
  // dismiss a question a single-page app is waiting on. The review bubble closes itself on blur.
  closeOn: { blur: false, tabSwitch: true, navigation: false, layout: false },
  keep: 'fresh',
  height: { initial: 170, min: 100, max: 460 },
  attach: (win) => createSitePrompt(win)
}
