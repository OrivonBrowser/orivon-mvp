import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OverlayHandler, OverlayWindow } from '../../../overlays/overlay-types.js'
import { MAX_WAITING, slotClosed, tabSlotEvents } from '../../../overlays/tab-slots.js'
import { promptAnchorReport } from '../../actions/prompt-anchor.js'
import type { ShellWindow } from '../../window-registry.js'
import { createAskQuestion } from '../ask-question.js'
import { createQuestionPanel, QUESTION_OVERLAY, QUESTION_SHEET_OVERLAY } from '../question-overlay.js'
import { GUARD_MS, type QuestionResult, type QuestionSpec } from '../question-spec.js'

const CONSENT: QuestionSpec = { kind: 'consent', message: 'Allow?', buttons: ['Allow', 'Cancel'], cancelId: 1, guarded: [0] }
const NOTICE: QuestionSpec = { kind: 'notice', message: 'Refused', buttons: ['OK'], cancelId: 0 }
const PILL = { x: 120, y: 40, width: 600, height: 32 }

class FakeContents extends EventEmitter {
  destroyed = false
  isDestroyed (): boolean { return this.destroyed }
}

interface Shown { overlay: string, anchor: unknown, view: Record<string, unknown> | undefined }

/** A window whose overlay host shows and closes through the real question handlers, as the host does. */
function rig (options: { active?: string, kiosk?: boolean, chromeVisible?: boolean, reported?: boolean } = {}) {
  let active = options.active ?? 't1'
  const shown: Shown[] = []
  const closes: string[] = []
  const handlers = new Map<string, OverlayHandler>()
  const openTabs = new Set(['t1', 'other'])
  let windowGone = false
  const tabs = { getState: () => ({ activeTabId: active, tabs: [...openTabs].map((id) => ({ id })) }), exitHtmlFullscreen: vi.fn() }
  const chrome = { getVisible: () => chromeVisible }
  let chromeVisible = options.chromeVisible ?? true
  const window = {
    window: { isDestroyed: () => windowGone },
    tabs,
    chrome,
    overlays: {
      show: (overlay: string, anchor?: unknown, payload?: unknown) => {
        const handler = handlers.get(overlay)
        shown.push({ overlay, anchor, view: handler?.show?.(payload) as Record<string, unknown> | undefined })
      },
      close: (overlay?: string) => {
        if (overlay === undefined) return
        closes.push(overlay)
        handlers.get(overlay)?.closed?.('request')
      }
    }
  } as unknown as ShellWindow
  for (const name of [QUESTION_OVERLAY, QUESTION_SHEET_OVERLAY]) {
    const handler: OverlayHandler = createQuestionPanel(name)({
      window,
      close: () => { closes.push(name); handler.closed?.('request') },
      send: () => {}
    } as unknown as OverlayWindow)
    handlers.set(name, handler)
  }
  if (options.reported !== false) promptAnchorReport(PILL, { window } as never)
  const contents = new FakeContents()
  const native = vi.fn(async (): Promise<QuestionResult> => ({ response: 0, checkboxChecked: false }))
  const registry = {
    findTab: (c: unknown) => c === contents ? { window, tabId: 't1' } : null,
    focused: () => window
  }
  const ask = createAskQuestion({ windows: registry, kiosk: options.kiosk === true, native })
  const idShown = (): string => shown.at(-1)?.view?.['id'] as string
  const press = (button: number, id = idShown()): void => { handlers.get(shown.at(-1)?.overlay ?? '')?.request({ id, button }) }
  const drawn = (id = idShown()): void => { handlers.get(shown.at(-1)?.overlay ?? '')?.request({ type: 'drawn', id }) }
  return {
    window, contents, ask, shown, closes, native, tabs, press, idShown, drawn,
    activate: (id: string) => { active = id },
    closeTab: (id: string) => { openTabs.delete(id) },
    closeWindow: () => { windowGone = true },
    setChromeVisible: (visible: boolean) => { chromeVisible = visible },
    report: () => { promptAnchorReport(PILL, { window } as never) }
  }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('askQuestion', () => {
  it('shows the question in the tab it came from, anchored across the toolbar line, and resolves with the button', async () => {
    const r = rig()
    const answer = r.ask({ contents: r.contents }, CONSENT)
    await vi.advanceTimersByTimeAsync(0)
    expect(r.shown).toHaveLength(1)
    expect(r.shown[0]).toMatchObject({ overlay: QUESTION_OVERLAY, anchor: { x: PILL.x, y: PILL.y, width: PILL.width, height: PILL.height - 14 } })
    expect(r.shown[0]?.view).toMatchObject({ kind: 'consent', message: 'Allow?', guarded: [0] })
    r.drawn()
    await vi.advanceTimersByTimeAsync(GUARD_MS)
    r.press(0)
    expect(await answer).toEqual({ response: 0, checkboxChecked: false })
  })

  it('ignores the accepting button inside the guard, and resolves a cancel with the cancel index', async () => {
    const r = rig()
    const answer = r.ask({ contents: r.contents }, CONSENT)
    await vi.advanceTimersByTimeAsync(0)
    r.press(0)
    expect(r.closes).toEqual([])
    slotClosed(r.window, QUESTION_OVERLAY, 'escape')
    expect(await answer).toEqual({ response: 1, checkboxChecked: false })
  })

  it('shows nothing until the chrome has reported the address pill, then shows it', async () => {
    const r = rig({ reported: false })
    const answer = r.ask({ contents: r.contents }, CONSENT)
    await vi.advanceTimersByTimeAsync(200)
    expect(r.shown).toHaveLength(0)
    r.report()
    await vi.advanceTimersByTimeAsync(100)
    expect(r.shown).toHaveLength(1)
    slotClosed(r.window, QUESTION_OVERLAY, 'escape')
    await answer
  })

  it('asks a page holding the screen to let go, and waits for the toolbar to come back', async () => {
    const r = rig({ chromeVisible: false })
    const answer = r.ask({ contents: r.contents }, CONSENT)
    await vi.advanceTimersByTimeAsync(100)
    expect(r.tabs.exitHtmlFullscreen).toHaveBeenCalledWith('t1')
    expect(r.shown).toHaveLength(0)
    r.setChromeVisible(true)
    await vi.advanceTimersByTimeAsync(100)
    expect(r.shown).toHaveLength(1)
    slotClosed(r.window, QUESTION_OVERLAY, 'escape')
    await answer
  })

  it('gives up as a cancel when the toolbar never comes into view', async () => {
    const r = rig({ chromeVisible: false })
    const answer = r.ask({ contents: r.contents }, CONSENT)
    await vi.advanceTimersByTimeAsync(6000)
    expect(await answer).toEqual({ response: 1, checkboxChecked: false })
    expect(r.shown).toHaveLength(0)
  })

  it('does not wait for the toolbar to show a notice', async () => {
    const r = rig({ chromeVisible: false, reported: false })
    const answer = r.ask({ contents: r.contents }, NOTICE)
    expect(r.shown).toHaveLength(1)
    expect(r.tabs.exitHtmlFullscreen).not.toHaveBeenCalled()
    slotClosed(r.window, QUESTION_OVERLAY, 'escape')
    await answer
  })

  it('draws a kiosk question as a centred sheet at once, since there is no toolbar to cross', async () => {
    const r = rig({ kiosk: true, chromeVisible: false, reported: false })
    const answer = r.ask({ contents: r.contents }, CONSENT)
    expect(r.shown.map((s) => s.overlay)).toEqual([QUESTION_SHEET_OVERLAY])
    slotClosed(r.window, QUESTION_SHEET_OVERLAY, 'escape')
    await answer
  })

  it('resolves a cancel when the tab closes', async () => {
    const r = rig()
    const answer = r.ask({ contents: r.contents }, CONSENT)
    await vi.advanceTimersByTimeAsync(0)
    tabSlotEvents.tabClosed(r.window, 't1')
    expect(await answer).toEqual({ response: 1, checkboxChecked: false })
  })

  it('resolves a cancel when the tab closes while the question waits for the toolbar, and never shows it', async () => {
    const r = rig({ chromeVisible: false })
    const answer = r.ask({ contents: r.contents }, CONSENT)
    await vi.advanceTimersByTimeAsync(100)
    r.closeTab('t1')
    tabSlotEvents.tabClosed(r.window, 't1')
    await vi.advanceTimersByTimeAsync(100)
    expect(await answer).toEqual({ response: 1, checkboxChecked: false })
    r.setChromeVisible(true)
    await vi.advanceTimersByTimeAsync(200)
    expect(r.shown).toHaveLength(0)
  })

  it('resolves a cancel when the window closes while the question waits for the toolbar, and never shows it', async () => {
    const r = rig({ chromeVisible: false })
    const answer = r.ask({ contents: r.contents }, CONSENT)
    await vi.advanceTimersByTimeAsync(100)
    r.closeWindow()
    await vi.advanceTimersByTimeAsync(100)
    expect(await answer).toEqual({ response: 1, checkboxChecked: false })
    r.setChromeVisible(true)
    await vi.advanceTimersByTimeAsync(200)
    expect(r.shown).toHaveLength(0)
  })

  it('resolves a cancel, shows nothing, when the tab is gone by the time the toolbar is in view', async () => {
    const r = rig({ reported: false })
    const answer = r.ask({ contents: r.contents }, CONSENT)
    await vi.advanceTimersByTimeAsync(60)
    r.closeTab('t1')
    r.report()
    await vi.advanceTimersByTimeAsync(100)
    expect(await answer).toEqual({ response: 1, checkboxChecked: false })
    expect(r.shown).toHaveLength(0)
  })

  it('resolves a cancel when aborted, shown or still waiting, and never shows an aborted one', async () => {
    const shownRig = rig()
    const controller = new AbortController()
    const shownAnswer = shownRig.ask({ contents: shownRig.contents }, CONSENT, { signal: controller.signal })
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    expect(await shownAnswer).toEqual({ response: 1, checkboxChecked: false })
    expect(shownRig.closes).toEqual([QUESTION_OVERLAY])

    const waiting = rig({ chromeVisible: false })
    const second = new AbortController()
    const waitingAnswer = waiting.ask({ contents: waiting.contents }, CONSENT, { signal: second.signal })
    await vi.advanceTimersByTimeAsync(100)
    second.abort()
    expect(await waitingAnswer).toEqual({ response: 1, checkboxChecked: false })
    waiting.setChromeVisible(true)
    await vi.advanceTimersByTimeAsync(200)
    expect(waiting.shown).toHaveLength(0)

    const already = rig()
    const done = new AbortController()
    done.abort()
    expect(await already.ask({ contents: already.contents }, CONSENT, { signal: done.signal })).toEqual({ response: 1, checkboxChecked: false })
    expect(already.shown).toHaveLength(0)
  })

  it('ends when the tab loads another page, only if asked to', async () => {
    const r = rig()
    const ends = r.ask({ contents: r.contents }, CONSENT, { endOnNavigation: true })
    await vi.advanceTimersByTimeAsync(0)
    r.contents.emit('did-navigate')
    expect(await ends).toEqual({ response: 1, checkboxChecked: false })
    expect(r.contents.listenerCount('did-navigate')).toBe(0)

    const stays = rig()
    let settled = false
    void stays.ask({ contents: stays.contents }, CONSENT).then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(0)
    stays.contents.emit('did-navigate')
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
  })

  it('makes a question for a background tab wait for its tab', async () => {
    const r = rig({ active: 'other' })
    const answer = r.ask({ contents: r.contents }, CONSENT)
    await vi.advanceTimersByTimeAsync(0)
    expect(r.shown).toHaveLength(0)
    r.activate('t1')
    tabSlotEvents.tabActivated(r.window, 't1')
    await vi.advanceTimersByTimeAsync(0)
    expect(r.shown).toHaveLength(1)
    slotClosed(r.window, QUESTION_OVERLAY, 'escape')
    await answer
  })

  it('cancels the ones past the queue limit', async () => {
    const r = rig()
    const answers = Array.from({ length: MAX_WAITING + 2 }, () => r.ask({ contents: r.contents }, CONSENT))
    await vi.advanceTimersByTimeAsync(0)
    expect(r.shown).toHaveLength(1)
    expect(await Promise.race([answers[MAX_WAITING + 1], Promise.resolve('waiting')])).toEqual({ response: 1, checkboxChecked: false })
  })

  it('takes a window and a tab id for a question the shell asks itself', async () => {
    const r = rig()
    const answer = r.ask({ window: r.window, tabId: 't1' }, NOTICE)
    expect(r.shown).toHaveLength(1)
    r.press(0)
    expect(await answer).toEqual({ response: 0, checkboxChecked: false })
    expect(r.native).not.toHaveBeenCalled()
  })

  it('sends a question with no contents to the tab in front in the focused window, never the native box', async () => {
    const r = rig()
    const answer = r.ask({}, NOTICE)
    expect(r.shown).toHaveLength(1)
    r.press(0)
    await answer
    expect(r.native).not.toHaveBeenCalled()
  })

  it('sends contents that are no tab (a popup, a side panel) to the focused window too', async () => {
    const r = rig()
    const answer = r.ask({ contents: new FakeContents() }, NOTICE)
    expect(r.shown).toHaveLength(1)
    r.press(0)
    await answer
    expect(r.native).not.toHaveBeenCalled()
  })

  it('cancels a question about contents that are already gone', async () => {
    const r = rig()
    r.contents.destroyed = true
    expect(await r.ask({ contents: r.contents }, CONSENT)).toEqual({ response: 1, checkboxChecked: false })
    expect(r.shown).toHaveLength(0)
  })

  it('falls back to the native box only when no shell window exists', async () => {
    const native = vi.fn(async (): Promise<QuestionResult> => ({ response: 0, checkboxChecked: true }))
    const ask = createAskQuestion({ windows: { findTab: () => null, focused: () => undefined }, kiosk: false, native })
    expect(await ask({}, NOTICE)).toEqual({ response: 0, checkboxChecked: true })
    expect(native).toHaveBeenCalledTimes(1)
  })

  it('holds the guard in main: the accept button of a shown question does nothing early, whatever the page sends', async () => {
    const r = rig()
    let settled = false
    void r.ask({ contents: r.contents }, CONSENT).then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(GUARD_MS * 4)
    r.press(0)
    r.drawn()
    await vi.advanceTimersByTimeAsync(GUARD_MS - 1)
    r.press(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
  })
})
