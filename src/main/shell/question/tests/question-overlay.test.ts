import { describe, expect, it, vi } from 'vitest'
import type { OverlayWindow } from '../../../overlays/overlay-types.js'
import type { ShellWindow } from '../../window-registry.js'
import { createQuestionPanel, heldQuestion, holdQuestion, questionOverlay, questionSheetOverlay, QUESTION_OVERLAY, QUESTION_SHEET_OVERLAY, releaseQuestion } from '../question-overlay.js'
import { GUARD_MS, normaliseSpec, type QuestionResult, type QuestionSpec } from '../question-spec.js'

const SPEC: QuestionSpec = normaliseSpec({ kind: 'consent', message: 'Allow?', buttons: ['Allow', 'Cancel'], cancelId: 1, guarded: [0] })

function rig (spec: QuestionSpec = SPEC) {
  const clock = { now: 1000 }
  const window = {} as unknown as ShellWindow
  const close = vi.fn()
  const send = vi.fn()
  const handler = createQuestionPanel(QUESTION_OVERLAY, () => clock.now)({ window, close, send } as unknown as OverlayWindow)
  const results: QuestionResult[] = []
  const id = holdQuestion(window, spec, (result) => { results.push(result) })
  return { clock, window, close, send, handler, results, id }
}

/** The page reports that it has drawn what it was shown. */
const draw = (r: ReturnType<typeof rig>, id: string = r.id): unknown => r.handler.request({ type: 'drawn', id })

describe('the question overlays', () => {
  it('are bar panels that take focus, hide on a tab switch and never close on blur', () => {
    for (const def of [questionOverlay, questionSheetOverlay]) {
      expect(def).toMatchObject({ surface: 'panel', focus: 'take', layer: 'bar', keep: 'fresh' })
      expect(def.closeOn).toEqual({ blur: false, tabSwitch: true, navigation: false, layout: false })
    }
    expect(questionOverlay.name).toBe(QUESTION_OVERLAY)
    expect(questionSheetOverlay.name).toBe(QUESTION_SHEET_OVERLAY)
    expect(questionSheetOverlay.placement).toMatchObject({ kind: 'area', at: 'center' })
  })
})

describe('the question handler', () => {
  it('shows what main holds for the id, with random ids no one can guess', () => {
    const r = rig()
    expect(r.id).toMatch(/^[0-9a-f]{24}$/)
    expect(r.handler.show?.({ id: r.id })).toMatchObject({ id: r.id, message: 'Allow?', buttons: ['Allow', 'Cancel'], guarded: [0], guardMs: GUARD_MS })
    expect(r.handler.show?.({ id: 'made-up' })).toBeUndefined()
    expect(r.handler.show?.({})).toBeUndefined()
    expect(r.handler.show?.(null)).toBeUndefined()
  })

  it('does not show a question held for another window', () => {
    const r = rig()
    const other = createQuestionPanel(QUESTION_OVERLAY)({ window: {} as ShellWindow, close: vi.fn(), send: vi.fn() } as unknown as OverlayWindow)
    expect(other.show?.({ id: r.id })).toBeUndefined()
  })

  it('ignores a guarded button until the guard has passed, counted from the page drawing', () => {
    const r = rig()
    r.handler.show?.({ id: r.id })
    draw(r)
    r.clock.now += GUARD_MS - 1
    r.handler.request({ id: r.id, button: 0 })
    expect(r.results).toEqual([])
    expect(r.close).not.toHaveBeenCalled()
    r.clock.now += 1
    r.handler.request({ id: r.id, button: 0 })
    expect(r.results).toEqual([{ response: 0, checkboxChecked: false }])
    expect(r.close).toHaveBeenCalledTimes(1)
  })

  it('ignores a guarded button until the page has drawn, however long since the show', () => {
    const r = rig()
    r.handler.show?.({ id: r.id })
    r.clock.now += GUARD_MS * 10
    r.handler.request({ id: r.id, button: 0 })
    expect(r.results).toEqual([])
    draw(r)
    r.clock.now += GUARD_MS - 1
    r.handler.request({ id: r.id, button: 0 })
    expect(r.results).toEqual([])
    r.clock.now += 1
    r.handler.request({ id: r.id, button: 0 })
    expect(r.results).toEqual([{ response: 0, checkboxChecked: false }])
  })

  it('refuses a guarded button within the guard of the last key, however long since the page drew', () => {
    const r = rig()
    r.handler.show?.({ id: r.id })
    draw(r)
    r.clock.now += GUARD_MS * 10
    r.handler.key?.({ key: 'Tab', isAutoRepeat: false })
    r.clock.now += 100
    r.handler.key?.({ key: 'Tab', isAutoRepeat: false })
    r.clock.now += 100
    r.handler.request({ id: r.id, button: 0 })
    expect(r.results).toEqual([])
    r.clock.now += GUARD_MS
    r.handler.request({ id: r.id, button: 0 })
    expect(r.results).toEqual([{ response: 0, checkboxChecked: false }])
  })

  it('takes the letters typed into a question\'s own text box as its answer, so Enter right after them answers', () => {
    const r = rig(normaliseSpec({ kind: 'confirm', message: 'Your name?', buttons: ['OK', 'Cancel'], cancelId: 1, guarded: [0], input: { initial: '' } }))
    r.handler.show?.({ id: r.id })
    draw(r)
    r.clock.now += GUARD_MS
    for (const key of ['A', 'd', 'a']) {
      r.handler.key?.({ key, isAutoRepeat: false })
      r.clock.now += 50
    }
    r.handler.key?.({ key: 'Enter', isAutoRepeat: false })
    r.handler.request({ id: r.id, button: 0, text: 'Ada' })
    expect(r.results).toEqual([{ response: 0, checkboxChecked: false, text: 'Ada' }])
  })

  it('still waits after a Tab in a question with a text box', () => {
    const r = rig(normaliseSpec({ kind: 'confirm', message: 'Your name?', buttons: ['OK', 'Cancel'], cancelId: 1, guarded: [0], input: { initial: '' } }))
    r.handler.show?.({ id: r.id })
    draw(r)
    r.clock.now += GUARD_MS
    r.handler.key?.({ key: 'Tab', isAutoRepeat: false })
    r.handler.request({ id: r.id, button: 0, text: 'x' })
    expect(r.results).toEqual([])
  })

  it('lets one Enter on the focused button answer, once the keys before it have been quiet', () => {
    const r = rig()
    r.handler.show?.({ id: r.id })
    draw(r)
    r.clock.now += GUARD_MS
    r.handler.key?.({ key: 'Tab', isAutoRepeat: false })
    r.clock.now += GUARD_MS
    expect(r.handler.key?.({ key: 'Enter', isAutoRepeat: false })).toBe(false)
    r.handler.request({ id: r.id, button: 0 })
    expect(r.results).toEqual([{ response: 0, checkboxChecked: false }])
  })

  it('never answers from a held Enter or Space: its repeats are swallowed and restart the guard', () => {
    const r = rig()
    r.handler.show?.({ id: r.id })
    draw(r)
    r.clock.now += GUARD_MS * 10
    expect(r.handler.key?.({ key: 'Enter', isAutoRepeat: true })).toBe(true)
    expect(r.handler.key?.({ key: ' ', isAutoRepeat: true })).toBe(true)
    r.clock.now += 100
    r.handler.request({ id: r.id, button: 0 })
    expect(r.results).toEqual([])
  })

  it('takes a report of drawing only for the question on screen, once', () => {
    const r = rig()
    draw(r)
    r.clock.now += GUARD_MS
    r.handler.request({ id: r.id, button: 0 })
    expect(r.results).toEqual([])
    r.handler.show?.({ id: r.id })
    draw(r, 'someone-else')
    r.handler.request({ type: 'drawn', id: r.id, extra: 1 })
    r.clock.now += GUARD_MS
    r.handler.request({ id: r.id, button: 0 })
    expect(r.results).toEqual([])
    draw(r)
    r.clock.now += GUARD_MS - 1
    draw(r)
    r.clock.now += 1
    r.handler.request({ id: r.id, button: 0 })
    expect(r.results).toEqual([{ response: 0, checkboxChecked: false }])
  })

  it('takes an unguarded button at once', () => {
    const r = rig()
    r.handler.show?.({ id: r.id })
    r.handler.request({ id: r.id, button: 1 })
    expect(r.results).toEqual([{ response: 1, checkboxChecked: false }])
  })

  it('starts the guard over on every show, so a tab switch back does not leave a ready button', () => {
    const r = rig()
    r.handler.show?.({ id: r.id })
    draw(r)
    r.clock.now += GUARD_MS * 4
    r.handler.show?.({ id: r.id })
    draw(r)
    r.handler.request({ id: r.id, button: 0 })
    expect(r.results).toEqual([])
  })

  it('starts the guard over when moved, and tells the page', () => {
    const r = rig()
    r.handler.show?.({ id: r.id })
    draw(r)
    r.clock.now += GUARD_MS
    r.handler.moved?.()
    expect(r.send).toHaveBeenCalledWith({ type: 'arm' })
    r.handler.request({ id: r.id, button: 0 })
    expect(r.results).toEqual([])
  })

  it.each([
    ['no command', undefined], ['a string', 'go'], ['an extra key', { button: 1, extra: 1 }], ['a text on a question without a box', { button: 1, text: 'x' }],
    ['a tick on a question without a checkbox', { button: 1, checkbox: true }], ['a non-number button', { button: '1' }],
    ['a fractional button', { button: 0.5 }], ['a button out of range', { button: 2 }], ['a negative button', { button: -1 }],
    ['the wrong id', { id: 'nope', button: 1 }], ['no button', {}]
  ])('ignores %s', (_name, command) => {
    const r = rig()
    r.handler.show?.({ id: r.id })
    draw(r)
    r.clock.now += GUARD_MS
    const bound = typeof command === 'object' && !('id' in command) ? { id: r.id, ...command } : command
    r.handler.request(bound)
    expect(r.results).toEqual([])
    expect(r.close).not.toHaveBeenCalled()
  })

  it('answers only the question on screen, not another one held for the window', () => {
    const r = rig()
    const second: QuestionResult[] = []
    const otherId = holdQuestion(r.window, SPEC, (result) => { second.push(result) })
    r.handler.show?.({ id: r.id })
    draw(r)
    r.clock.now += GUARD_MS
    r.handler.request({ id: otherId, button: 1 })
    expect(second).toEqual([])
    releaseQuestion(otherId)
  })

  it('returns the text and the tick only when the spec asked for them', () => {
    const spec = normaliseSpec({ kind: 'page-prompt', message: 'Name?', buttons: ['OK', 'Cancel'], cancelId: 1, input: { initial: 'x' }, checkboxLabel: 'Stop asking' })
    const r = rig(spec)
    r.handler.show?.({ id: r.id })
    r.handler.request({ id: r.id, button: 0, text: 'ada', checkbox: true })
    expect(r.results).toEqual([{ response: 0, checkboxChecked: true, text: 'ada' }])
  })

  it('refuses a text longer than a box can hold', () => {
    const spec = normaliseSpec({ kind: 'page-prompt', message: 'Name?', buttons: ['OK'], cancelId: 0, input: { initial: '' } })
    const r = rig(spec)
    r.handler.show?.({ id: r.id })
    r.handler.request({ id: r.id, button: 0, text: 'x'.repeat(100_001) })
    expect(r.results).toEqual([])
  })

  it('takes an answer of some thousands of characters, and keeps a long default whole', () => {
    const long = 'y'.repeat(5000)
    const spec = normaliseSpec({ kind: 'page-prompt', message: 'Paste it', buttons: ['OK'], cancelId: 0, input: { initial: long } })
    expect(spec.input?.initial).toBe(long)
    const r = rig(spec)
    r.handler.show?.({ id: r.id })
    draw(r)
    r.clock.now += GUARD_MS
    r.handler.request({ id: r.id, button: 0, text: 'x'.repeat(5000) })
    expect(r.results).toEqual([{ response: 0, checkboxChecked: false, text: 'x'.repeat(5000) }])
  })

  it('settles every question held for its window as a cancel when the window goes', () => {
    const r = rig()
    r.handler.disposed?.()
    expect(r.results).toEqual([{ response: 1, checkboxChecked: false }])
  })

  it('forgets a released question', () => {
    const r = rig()
    releaseQuestion(r.id)
    expect(heldQuestion(r.id)).toBeUndefined()
    expect(r.handler.show?.({ id: r.id })).toBeUndefined()
  })
})
