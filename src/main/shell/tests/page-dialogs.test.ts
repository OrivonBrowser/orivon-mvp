import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { AskQuestion } from '../question/ask-question.js'
import type { QuestionResult, QuestionSpec } from '../question/question-spec.js'

vi.mock('electron', () => ({}))
const { PAGE_DIALOG_CHANNEL } = await import('../../channels.js')
const { formatOriginForDisplay } = await import('../../consent/grant-prompt-origin.js')
const { defaultReply, hasPendingPageDialog, pageDialogSpec, readRequest, replyFor, speaker, watchPageDialogs } = await import('../page-dialogs.js')

const MAIN = { origin: 'https://shop.example', parent: null, detached: false }
const FRAME = { origin: 'https://ads.example', parent: MAIN, detached: false }
const OPAQUE = { origin: 'null', parent: MAIN, detached: false }

type Frame = typeof MAIN | typeof FRAME | typeof OPAQUE

interface Rig {
  wc: EventEmitter & { isDestroyed: () => boolean, getOSProcessId: () => number, mainFrame: typeof MAIN, ipc: { on: ReturnType<typeof vi.fn> } }
  ask: ReturnType<typeof vi.fn>
  /** Sends one dialog the way Electron's `-run-dialog` does, and returns what the page would read. */
  run: (type: string, message?: string, frame?: Frame | null, defaultText?: string) => { value: unknown, replied: boolean }
  /** Sends one prompt the way the preload does. */
  send: (raw: unknown, frame?: Frame | null) => { value: unknown, replied: boolean }
  shown: { value: boolean }
  /** The handler Electron installed for the event, which the shell takes over. */
  electron: ReturnType<typeof vi.fn>
}

let nextProcessId = 100

/** `ask` answers nothing until told: each call parks a resolver, and an abort answers it as a cancel. */
function rig (answer?: (spec: QuestionSpec) => QuestionResult | Promise<QuestionResult>, internalListeners = 1): Rig {
  const wc = new EventEmitter() as Rig['wc']
  wc.isDestroyed = () => false
  const processId = nextProcessId++
  wc.getOSProcessId = () => processId
  wc.mainFrame = MAIN
  wc.ipc = { on: vi.fn() }
  const electron = vi.fn()
  for (let i = 0; i < internalListeners; i++) wc.on('-run-dialog', electron)
  const shown = { value: true }
  const ask = vi.fn(async (_target: unknown, spec: QuestionSpec, options?: { signal?: AbortSignal }): Promise<QuestionResult> => {
    if (answer !== undefined) return await answer(spec)
    return await new Promise<QuestionResult>((resolve) => {
      options?.signal?.addEventListener('abort', () => { resolve({ response: spec.cancelId, checkboxChecked: false }) }, { once: true })
    })
  })
  watchPageDialogs(wc as unknown as WebContents, () => shown.value, ask as unknown as AskQuestion)
  const handler = wc.ipc.on.mock.calls[0]?.[1] as (event: unknown, raw: unknown) => void
  expect(wc.ipc.on.mock.calls[0]?.[0]).toBe(PAGE_DIALOG_CHANNEL)
  return {
    wc,
    ask,
    shown,
    electron,
    run: (type, message = 'hello', frame = MAIN, defaultText = '') => {
      const out = { value: undefined as unknown, replied: false }
      const callback = (success: boolean, input: string): void => {
        out.replied = true
        out.value = type === 'alert' ? undefined : type === 'confirm' ? success : success ? input : null
      }
      wc.emit('-run-dialog', { frame, dialogType: type, messageText: message, defaultPromptText: defaultText }, callback)
      return out
    },
    send: (raw, frame = MAIN) => {
      const out = { value: undefined as unknown, replied: false }
      const event = {
        senderFrame: frame,
        set returnValue (value: unknown) { out.value = value; out.replied = true }
      }
      handler(event, raw)
      return out
    }
  }
}

const flush = async (): Promise<void> => { await new Promise((resolve) => { setTimeout(resolve, 0) }) }
const request = (type: string, message = 'hello', defaultText = ''): unknown => ({ type, message, defaultText })

describe('what a page may send', () => {
  it('accepts exactly a type, a message and a default text', () => {
    expect(readRequest(request('alert'))).toEqual({ type: 'alert', message: 'hello', defaultText: '' })
    expect(readRequest({ ...(request('alert') as object), extra: 1 })).toBeUndefined()
    expect(readRequest(request('print'))).toBeUndefined()
    expect(readRequest({ type: 'alert', message: 1, defaultText: '' })).toBeUndefined()
    expect(readRequest(null)).toBeUndefined()
    expect(readRequest('alert')).toBeUndefined()
  })

  it('cuts text a page makes enormous before anything works on it', () => {
    expect(readRequest(request('alert', 'x'.repeat(500_000)))?.message.length).toBe(100_000)
  })
})

describe('the question one dialog becomes', () => {
  const alert = readRequest(request('alert', 'hi'))!
  const confirm = readRequest(request('confirm', 'sure?'))!
  const prompt = readRequest(request('prompt', 'name?', 'Ada'))!

  it('draws an alert with one button and a confirm or prompt with two', () => {
    expect(pageDialogSpec(alert, 'https://a.example', false)).toMatchObject({ kind: 'page-alert', buttons: ['OK'], cancelId: 0, origin: 'https://a.example' })
    expect(pageDialogSpec(confirm, undefined, false)).toMatchObject({ kind: 'page-confirm', buttons: ['OK', 'Cancel'], cancelId: 1 })
    expect(pageDialogSpec(prompt, undefined, false)).toMatchObject({ kind: 'page-prompt', input: { initial: 'Ada' } })
  })

  it('guards the OK a key meant for the page could land on, and nothing else', () => {
    expect(pageDialogSpec(alert, undefined, false).guarded).toBeUndefined()
    expect(pageDialogSpec(confirm, undefined, false).guarded).toEqual([0])
    expect(pageDialogSpec(prompt, undefined, false).guarded).toEqual([0])
  })

  it('offers to stop further dialogs only when asked to', () => {
    expect(pageDialogSpec(alert, undefined, false).checkboxLabel).toBeUndefined()
    expect(pageDialogSpec(alert, undefined, true).checkboxLabel).toMatch(/more dialogs/)
  })

  it('names who speaks: the page, or a frame inside it, by the frame\'s own origin', () => {
    expect(speaker('https://shop.example', true)).toBe('https://shop.example')
    expect(speaker('https://ads.example', false)).toBe('An embedded page on https://ads.example')
    expect(speaker('null', true)).toBeUndefined()
    expect(speaker('null', false)).toBe('An embedded page')
  })

  it('writes the origin the way the rest of the shell does: a long host keeps its authority end', () => {
    expect(speaker('https://a.b.c.d.shop.example', true)).toBe(formatOriginForDisplay('https://a.b.c.d.shop.example'))
    expect(speaker('https://a.b.c.d.shop.example', true)).not.toContain('a.b.c.d')
    expect(speaker('https://a.b.c.d.ads.example', false)).toBe(`An embedded page on ${formatOriginForDisplay('https://a.b.c.d.ads.example')}`)
  })

  it('reads the person\'s answer as the page\'s own function would return it', () => {
    const ok: QuestionResult = { response: 0, checkboxChecked: false, text: 'Grace' }
    const cancel: QuestionResult = { response: 1, checkboxChecked: false }
    expect(replyFor(alert, pageDialogSpec(alert, undefined, false), ok)).toBeUndefined()
    expect(replyFor(confirm, pageDialogSpec(confirm, undefined, false), ok)).toBe(true)
    expect(replyFor(confirm, pageDialogSpec(confirm, undefined, false), cancel)).toBe(false)
    expect(replyFor(prompt, pageDialogSpec(prompt, undefined, false), ok)).toBe('Grace')
    expect(replyFor(prompt, pageDialogSpec(prompt, undefined, false), cancel)).toBeNull()
    expect(defaultReply('alert')).toBeUndefined()
    expect(defaultReply('confirm')).toBe(false)
    expect(defaultReply('prompt')).toBeNull()
  })
})

describe('taking over Electron\'s dialog event', () => {
  it('replaces the one handler Electron installed, and listens for its cancel event', () => {
    const r = rig()
    expect(r.wc.listeners('-run-dialog')).toHaveLength(1)
    expect(r.wc.listeners('-run-dialog')[0]).not.toBe(r.electron)
    expect(r.wc.listeners('-cancel-dialogs')).toHaveLength(1)
    r.run('alert')
    expect(r.electron).not.toHaveBeenCalled()
  })

  it('leaves Electron\'s handler in place, and says so once, when it is not exactly one', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const none = rig(undefined, 0)
      expect(none.wc.listeners('-run-dialog')).toHaveLength(0)
      const two = rig(undefined, 2)
      expect(two.wc.listeners('-run-dialog')).toHaveLength(2)
      expect(two.wc.listeners('-run-dialog').every((listener) => listener === two.electron)).toBe(true)
      expect(two.wc.listeners('-cancel-dialogs')).toHaveLength(0)
      expect(log.mock.calls.length).toBeLessThanOrEqual(1)
    } finally {
      log.mockRestore()
    }
  })

  it('pins the shape Electron raises: the frame, the type, the text and the default text, then a callback of an answer and an input', async () => {
    const r = rig((spec) => ({ response: 0, checkboxChecked: false, ...(spec.kind === 'page-prompt' ? { text: 'typed' } : {}) }))
    const seen: unknown[] = []
    r.wc.emit('-run-dialog', { frame: MAIN, dialogType: 'confirm', messageText: 'sure?', defaultPromptText: '' }, (...args: unknown[]) => { seen.push(args) })
    await flush()
    expect(seen).toEqual([[true, '']])
    expect(r.ask.mock.calls[0]?.[1]).toMatchObject({ kind: 'page-confirm', message: 'sure?' })
  })

  it('answers a call it cannot read as dismissed, so the page never waits on nothing', () => {
    const r = rig()
    const seen: unknown[] = []
    const callback = (...args: unknown[]): void => { seen.push(args) }
    r.wc.emit('-run-dialog', { frame: MAIN, dialogType: 'beforeunload', messageText: 'x' }, callback)
    r.wc.emit('-run-dialog', { frame: MAIN, dialogType: 'alert' }, callback)
    expect(seen).toEqual([[false, ''], [false, '']])
    r.wc.emit('-run-dialog', null, callback)
    expect(seen).toHaveLength(2)
    expect(r.ask).not.toHaveBeenCalled()
  })
})

describe('answering a page that waits', () => {
  it('asks in the tab\'s panel and calls back with the answer once it comes', async () => {
    const r = rig(() => ({ response: 0, checkboxChecked: false, text: 'typed' }))

    const alert = r.run('alert')
    expect(alert.replied).toBe(false)
    await flush()
    expect(alert).toEqual({ value: undefined, replied: true })
    expect(r.ask.mock.calls[0]?.[0]).toEqual({ contents: r.wc })
    expect(r.ask.mock.calls[0]?.[1]).toMatchObject({ kind: 'page-alert', origin: 'https://shop.example' })

    const confirm = r.run('confirm')
    await flush()
    expect(confirm.value).toBe(true)
  })

  it('answers a Cancel as false for a confirm', async () => {
    const r = rig((spec) => ({ response: spec.cancelId, checkboxChecked: false }))
    const confirm = r.run('confirm')
    await flush()
    expect(confirm).toEqual({ value: false, replied: true })
  })

  it('answers a prompt from the preload with the typed text, and only from the top frame', async () => {
    const r = rig(() => ({ response: 0, checkboxChecked: false, text: 'Ada' }))
    const prompt = r.send(request('prompt', 'q', 'd'))
    await flush()
    expect(prompt.value).toBe('Ada')
    expect(r.ask.mock.calls[0]?.[1]).toMatchObject({ kind: 'page-prompt', input: { initial: 'd' } })

    const frame = r.send(request('prompt'), FRAME)
    expect(frame).toEqual({ value: null, replied: true })
    expect(r.ask).toHaveBeenCalledTimes(1)
  })

  it('takes no alert or confirm from the preload channel: those are Electron\'s event only', () => {
    const r = rig()
    expect(r.send(request('alert'))).toEqual({ value: undefined, replied: true })
    expect(r.send(request('confirm'))).toEqual({ value: false, replied: true })
    expect(r.ask).not.toHaveBeenCalled()
  })

  it('says it is a frame inside the page that speaks, with the frame\'s own origin', async () => {
    const r = rig(() => ({ response: 0, checkboxChecked: false }))
    r.run('alert', 'hello', FRAME)
    r.run('alert', 'hello', OPAQUE)
    await flush()
    expect(r.ask.mock.calls[0]?.[1]).toMatchObject({ origin: 'An embedded page on https://ads.example' })
    expect(r.ask.mock.calls[1]?.[1]).toMatchObject({ origin: 'An embedded page' })
  })

  it('answers a call it cannot read at once, so the page never waits on nothing', () => {
    const r = rig()
    expect(r.send({ type: 'prompt' })).toEqual({ value: undefined, replied: true })
    expect(r.send(request('prompt'), null)).toEqual({ value: null, replied: true })
    expect(r.ask).not.toHaveBeenCalled()
  })

  it('sends nothing to Electron\'s callback when it names no frame: that is most likely a frame already gone', () => {
    const r = rig()
    expect(r.run('confirm', 'x', null)).toEqual({ value: undefined, replied: false })
    expect(r.ask).not.toHaveBeenCalled()
  })

  it('asks nothing for a view that is parked or being replaced', () => {
    const r = rig()
    r.shown.value = false
    expect(r.run('confirm')).toEqual({ value: false, replied: true })
    expect(r.send(request('prompt'))).toEqual({ value: null, replied: true })
    expect(r.ask).not.toHaveBeenCalled()
  })

  it('replies the default when the question could not be asked', async () => {
    const r = rig(() => { throw new Error('no window') })
    const confirm = r.run('confirm')
    await flush()
    expect(confirm).toEqual({ value: false, replied: true })
  })

  it('does not throw when the page is already gone by the time it is answered', async () => {
    const r = rig(() => ({ response: 0, checkboxChecked: false }))
    const gone = (): void => { throw new Error('Object has been destroyed') }
    expect(() => { r.wc.emit('-run-dialog', { frame: MAIN, dialogType: 'alert', messageText: 'x' }, gone) }).not.toThrow()
    const handler = r.wc.ipc.on.mock.calls[0]?.[1] as (event: unknown, raw: unknown) => void
    const dead = { senderFrame: MAIN, set returnValue (_value: unknown) { throw new Error('Object has been destroyed') } }
    expect(() => { handler(dead, request('prompt')) }).not.toThrow()
    await flush()
  })
})

describe('a page that leaves while it waits', () => {
  it('is answered the default when its main frame navigates, and stops counting as waiting', async () => {
    const r = rig()
    const confirm = r.run('confirm')
    expect(hasPendingPageDialog(r.wc as unknown as WebContents)).toBe(true)

    r.wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    await flush()

    expect(confirm).toEqual({ value: false, replied: true })
    expect(hasPendingPageDialog(r.wc as unknown as WebContents)).toBe(false)
  })

  it('closes its panels, and sends no answer, when Electron cancels its dialogs: Chromium has dropped the calls', async () => {
    const r = rig()
    const confirm = r.run('confirm')
    const prompt = r.send(request('prompt'))
    r.wc.emit('-cancel-dialogs')
    await flush()
    expect(confirm.replied).toBe(false)
    expect(prompt).toEqual({ value: null, replied: true })
    expect(hasPendingPageDialog(r.wc as unknown as WebContents)).toBe(false)
  })

  it('keeps asking through a same-document change or a frame\'s own navigation', () => {
    const r = rig()
    const confirm = r.run('confirm')
    r.wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    r.wc.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    expect(confirm.replied).toBe(false)
    expect(hasPendingPageDialog(r.wc as unknown as WebContents)).toBe(true)
  })

  it('closes its panels, and sends no answer to a renderer that is gone, when the page process dies or the tab is destroyed', async () => {
    const r = rig()
    const first = r.send(request('prompt'))
    r.wc.emit('render-process-gone')
    const second = r.run('confirm')
    r.wc.emit('destroyed')
    await flush()
    expect(first).toEqual({ value: null, replied: true })
    expect(second.replied).toBe(false)
    expect(hasPendingPageDialog(r.wc as unknown as WebContents)).toBe(false)
  })
})

describe('a frame that leaves while its dialog is open', () => {
  it('ends the panel, with no answer sent to the gone frame, when the frame is removed, and keeps it while the frame is there', async () => {
    vi.useFakeTimers()
    try {
      const frame = { origin: 'https://ads.example', parent: MAIN, detached: false }
      const r = rig()
      const confirm = r.run('confirm', 'hello', frame)
      await vi.advanceTimersByTimeAsync(600)
      expect(confirm.replied).toBe(false)

      frame.detached = true
      await vi.advanceTimersByTimeAsync(300)
      expect(confirm.replied).toBe(false)
      expect(hasPendingPageDialog(r.wc as unknown as WebContents)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends nothing when the person answers after the frame went but before the poll saw it', async () => {
    vi.useFakeTimers()
    try {
      const frame = { origin: 'https://ads.example', parent: MAIN, detached: false }
      let answer: (result: QuestionResult) => void = () => {}
      const r = rig((): Promise<QuestionResult> => new Promise((resolve) => { answer = resolve }))
      const confirm = r.run('confirm', 'hello', frame)
      frame.detached = true
      answer({ response: 0, checkboxChecked: false })
      await vi.advanceTimersByTimeAsync(0)
      expect(confirm.replied).toBe(false)
      await vi.advanceTimersByTimeAsync(300)
      expect(confirm.replied).toBe(false)
      expect(hasPendingPageDialog(r.wc as unknown as WebContents)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends nothing to a tab destroyed before the answer', async () => {
    let answer: (result: QuestionResult) => void = () => {}
    const r = rig((): Promise<QuestionResult> => new Promise((resolve) => { answer = resolve }))
    const confirm = r.run('confirm')
    r.wc.isDestroyed = () => true
    answer({ response: 0, checkboxChecked: false })
    await flush()
    expect(confirm.replied).toBe(false)
  })

  it('treats a frame it can no longer read as removed', async () => {
    vi.useFakeTimers()
    try {
      const frame = { origin: 'https://ads.example', parent: MAIN, get detached (): boolean { throw new Error('Render frame was disposed') } }
      const r = rig()
      const alert = r.run('alert', 'hello', frame as never)
      await vi.advanceTimersByTimeAsync(300)
      expect(alert.replied).toBe(false)
      expect(hasPendingPageDialog(r.wc as unknown as WebContents)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not look at the top frame, which lives as long as the tab', async () => {
    vi.useFakeTimers()
    try {
      const r = rig()
      const confirm = r.run('confirm')
      await vi.advanceTimersByTimeAsync(2000)
      expect(confirm.replied).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('a renderer shared by two tabs', () => {
  it('is waiting, not hung, for the tab that did not ask as well', () => {
    const a = rig()
    const b = rig()
    const other = rig()
    b.wc.getOSProcessId = a.wc.getOSProcessId
    expect(hasPendingPageDialog(b.wc as unknown as WebContents)).toBe(false)

    a.run('confirm')
    expect(hasPendingPageDialog(a.wc as unknown as WebContents)).toBe(true)
    expect(hasPendingPageDialog(b.wc as unknown as WebContents)).toBe(true)
    expect(hasPendingPageDialog(other.wc as unknown as WebContents)).toBe(false)

    a.wc.emit('destroyed')
    expect(hasPendingPageDialog(b.wc as unknown as WebContents)).toBe(false)
  })
})

describe('a page that will not stop', () => {
  it('offers to stop after two dialogs, and then answers the rest at once until the next page', async () => {
    const r = rig((spec) => ({ response: 0, checkboxChecked: spec.checkboxLabel !== undefined }))
    r.run('alert')
    r.run('alert')
    await flush()
    expect(r.ask.mock.calls[1]?.[1].checkboxLabel).toBeUndefined()

    r.run('alert')
    await flush()
    expect(r.ask.mock.calls[2]?.[1].checkboxLabel).toMatch(/more dialogs/)

    const quiet = r.run('confirm')
    expect(quiet).toEqual({ value: false, replied: true })
    expect(r.ask).toHaveBeenCalledTimes(3)

    r.wc.emit('did-navigate')
    r.run('alert')
    await flush()
    expect(r.ask).toHaveBeenCalledTimes(4)
    expect(r.ask.mock.calls[3]?.[1].checkboxLabel).toBeUndefined()
  })

  it('keeps asking when the box is left unticked', async () => {
    const r = rig(() => ({ response: 0, checkboxChecked: false }))
    for (let i = 0; i < 5; i++) r.run('alert')
    await flush()
    expect(r.ask).toHaveBeenCalledTimes(5)
  })
})
