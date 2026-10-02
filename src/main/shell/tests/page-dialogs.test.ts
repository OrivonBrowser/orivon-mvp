import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { AskQuestion } from '../question/ask-question.js'
import type { QuestionResult, QuestionSpec } from '../question/question-spec.js'

vi.mock('electron', () => ({}))
const { PAGE_DIALOG_CHANNEL } = await import('../../channels.js')
const { defaultReply, hasPendingPageDialog, pageDialogSpec, readRequest, replyFor, speaker, watchPageDialogs } = await import('../page-dialogs.js')

const MAIN = { origin: 'https://shop.example', parent: null }
const FRAME = { origin: 'https://ads.example', parent: MAIN }
const OPAQUE = { origin: 'null', parent: MAIN }

type Frame = typeof MAIN | typeof FRAME | typeof OPAQUE

interface Rig {
  wc: EventEmitter & { isDestroyed: () => boolean, mainFrame: typeof MAIN, ipc: { on: ReturnType<typeof vi.fn> } }
  ask: ReturnType<typeof vi.fn>
  /** Sends one dialog the way the preload does, and returns what the page would read. */
  send: (raw: unknown, frame?: Frame | null) => { value: unknown, replied: boolean }
  shown: { value: boolean }
}

/** `ask` answers nothing until told: each call parks a resolver, and an abort answers it as a cancel. */
function rig (answer?: (spec: QuestionSpec) => QuestionResult | Promise<QuestionResult>): Rig {
  const wc = new EventEmitter() as Rig['wc']
  wc.isDestroyed = () => false
  wc.mainFrame = MAIN
  wc.ipc = { on: vi.fn() }
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

describe('answering a page that waits', () => {
  it('asks in the tab\'s panel and replies with the answer once it comes', async () => {
    const r = rig((spec) => ({ response: spec.kind === 'page-prompt' ? 0 : 0, checkboxChecked: false, text: 'typed' }))

    const alert = r.send(request('alert'))
    expect(alert.replied).toBe(false)
    await flush()
    expect(alert).toEqual({ value: undefined, replied: true })
    expect(r.ask.mock.calls[0]?.[0]).toEqual({ contents: r.wc })
    expect(r.ask.mock.calls[0]?.[1]).toMatchObject({ kind: 'page-alert', origin: 'https://shop.example' })

    const confirm = r.send(request('confirm'))
    const prompt = r.send(request('prompt', 'q', 'd'))
    await flush()
    expect(confirm.value).toBe(true)
    expect(prompt.value).toBe('typed')
  })

  it('says it is a frame inside the page that speaks, with the frame\'s own origin', async () => {
    const r = rig(() => ({ response: 0, checkboxChecked: false }))
    r.send(request('alert'), FRAME)
    r.send(request('alert'), OPAQUE)
    await flush()
    expect(r.ask.mock.calls[0]?.[1]).toMatchObject({ origin: 'An embedded page on https://ads.example' })
    expect(r.ask.mock.calls[1]?.[1]).toMatchObject({ origin: 'An embedded page' })
  })

  it('answers a call it cannot read at once, so the page never waits on nothing', () => {
    const r = rig()
    expect(r.send({ type: 'alert' })).toEqual({ value: undefined, replied: true })
    expect(r.send(request('alert'), null)).toEqual({ value: undefined, replied: true })
    expect(r.ask).not.toHaveBeenCalled()
  })

  it('asks nothing for a view that is parked or being replaced', () => {
    const r = rig()
    r.shown.value = false
    expect(r.send(request('confirm'))).toEqual({ value: false, replied: true })
    expect(r.send(request('prompt'))).toEqual({ value: null, replied: true })
    expect(r.ask).not.toHaveBeenCalled()
  })

  it('replies the default when the question could not be asked', async () => {
    const r = rig(() => { throw new Error('no window') })
    const confirm = r.send(request('confirm'))
    await flush()
    expect(confirm).toEqual({ value: false, replied: true })
  })

  it('does not throw when the page is already gone by the time it is answered', async () => {
    const r = rig(() => ({ response: 0, checkboxChecked: false }))
    const handler = r.wc.ipc.on.mock.calls[0]?.[1] as (event: unknown, raw: unknown) => void
    const gone = { senderFrame: MAIN, set returnValue (_value: unknown) { throw new Error('Object has been destroyed') } }
    expect(() => { handler(gone, request('alert')) }).not.toThrow()
    await flush()
  })
})

describe('a page that leaves while it waits', () => {
  it('is answered the default when its main frame navigates, and stops counting as waiting', async () => {
    const r = rig()
    const confirm = r.send(request('confirm'))
    expect(hasPendingPageDialog(r.wc as unknown as WebContents)).toBe(true)

    r.wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    await flush()

    expect(confirm).toEqual({ value: false, replied: true })
    expect(hasPendingPageDialog(r.wc as unknown as WebContents)).toBe(false)
  })

  it('keeps asking through a same-document change or a frame\'s own navigation', () => {
    const r = rig()
    const confirm = r.send(request('confirm'))
    r.wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    r.wc.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    expect(confirm.replied).toBe(false)
    expect(hasPendingPageDialog(r.wc as unknown as WebContents)).toBe(true)
  })

  it('is answered when the page process dies or the tab is destroyed', async () => {
    const r = rig()
    const first = r.send(request('prompt'))
    r.wc.emit('render-process-gone')
    const second = r.send(request('confirm'))
    r.wc.emit('destroyed')
    await flush()
    expect(first).toEqual({ value: null, replied: true })
    expect(second).toEqual({ value: false, replied: true })
  })
})

describe('a page that will not stop', () => {
  it('offers to stop after two dialogs, and then answers the rest at once until the next page', async () => {
    const r = rig((spec) => ({ response: 0, checkboxChecked: spec.checkboxLabel !== undefined }))
    r.send(request('alert'))
    r.send(request('alert'))
    await flush()
    expect(r.ask.mock.calls[1]?.[1].checkboxLabel).toBeUndefined()

    r.send(request('alert'))
    await flush()
    expect(r.ask.mock.calls[2]?.[1].checkboxLabel).toMatch(/more dialogs/)

    const quiet = r.send(request('confirm'))
    expect(quiet).toEqual({ value: false, replied: true })
    expect(r.ask).toHaveBeenCalledTimes(3)

    r.wc.emit('did-navigate')
    r.send(request('alert'))
    await flush()
    expect(r.ask).toHaveBeenCalledTimes(4)
    expect(r.ask.mock.calls[3]?.[1].checkboxLabel).toBeUndefined()
  })

  it('keeps asking when the box is left unticked', async () => {
    const r = rig(() => ({ response: 0, checkboxChecked: false }))
    for (let i = 0; i < 5; i++) r.send(request('alert'))
    await flush()
    expect(r.ask).toHaveBeenCalledTimes(5)
  })
})
