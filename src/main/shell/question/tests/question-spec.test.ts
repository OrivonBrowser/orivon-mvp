import { describe, expect, it } from 'vitest'
import { cleanText, GUARD_MS, MAX_BUTTONS, normaliseSpec, sanitizePageText, viewOf, type QuestionSpec } from '../question-spec.js'

const spec = (over: Partial<QuestionSpec> = {}): QuestionSpec => ({ kind: 'consent', message: 'Allow?', buttons: ['Allow', 'Cancel'], cancelId: 1, ...over })

describe('cleanText', () => {
  it('removes bidi marks and controls but keeps line breaks and tabs', () => {
    expect(cleanText('a‮b\u0007c‏d\u0000e\r\nf\tg', 100)).toBe('abcde\nf\tg')
  })

  it('cuts to a length with an ellipsis, counting characters rather than code units', () => {
    expect(cleanText('x'.repeat(30), 10)).toBe(`${'x'.repeat(7)}...`)
    expect(cleanText('\u{1F600}'.repeat(5), 5)).toBe('\u{1F600}'.repeat(5))
  })
})

describe('sanitizePageText', () => {
  it('caps the number of lines, so a page cannot push the buttons off the panel', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
    const out = sanitizePageText(lines)
    expect(out.split('\n')).toHaveLength(12)
    expect(out.endsWith('\n...')).toBe(true)
  })

  it('strips bidi overrides and controls, and caps the length', () => {
    expect(sanitizePageText('pay‮ 1000 to evil')).toBe('pay 1000 to evil')
    expect(sanitizePageText('y'.repeat(5000)).length).toBe(1000)
  })
})

describe('normaliseSpec', () => {
  it('cleans every string and keeps at most MAX_BUTTONS buttons', () => {
    const out = normaliseSpec(spec({ title: 'T‮', message: 'm\u0001', detail: 'd‏', origin: 'https://a.example‮', buttons: ['a', 'b', 'c', 'd', 'e'], cancelId: 3 }))
    expect(out).toMatchObject({ title: 'T', message: 'm', detail: 'd', origin: 'https://a.example' })
    expect(out.buttons).toHaveLength(MAX_BUTTONS)
  })

  it('keeps cancelId, focus and guarded inside the buttons', () => {
    const out = normaliseSpec(spec({ cancelId: 9, focus: 7, guarded: [0, 5, -1, 0, 1.5] }))
    expect(out.cancelId).toBe(1)
    expect(out.focus).toBe('dialog')
    expect(out.guarded).toEqual([0])
  })

  it('starts a consent question on the panel and a notice on its first button', () => {
    expect(normaliseSpec(spec()).focus).toBe('dialog')
    expect(normaliseSpec(spec({ kind: 'notice', buttons: ['OK'], cancelId: 0 })).focus).toBe(0)
  })

  it('sanitises the text of a page kind as a page wrote it', () => {
    const out = normaliseSpec({ kind: 'page-alert', message: Array.from({ length: 30 }, () => 'x').join('\n'), buttons: ['OK'], cancelId: 0 })
    expect(out.message.split('\n')).toHaveLength(12)
  })

  it('refuses a question with no button', () => {
    expect(() => normaliseSpec(spec({ buttons: [] }))).toThrow(/button/)
  })
})

describe('viewOf', () => {
  it('carries the guard length and the fields the panel draws', () => {
    const view = viewOf('abc', normaliseSpec(spec({ guarded: [0], origin: 'https://a.example' })))
    expect(view).toMatchObject({ id: 'abc', kind: 'consent', origin: 'https://a.example', guarded: [0], guardMs: GUARD_MS, warning: false })
  })

  const occurrences = (text: string, needle: string): number => text.split(needle).length - 1
  const shown = (view: ReturnType<typeof viewOf>): string => [view.origin, view.title, view.message, view.detail].filter((part) => part !== undefined).join('\n')

  it('names the origin once for a consent question that repeated it as title and last detail line', () => {
    const origin = 'http://127.0.0.1:45429'
    const view = viewOf('abc', normaliseSpec(spec({ origin, title: origin, message: 'This app wants to:', detail: `Claims to be "X".\n- Store files\n${origin}` })))
    expect(occurrences(shown(view), origin)).toBe(1)
    expect(view.origin).toBe(origin)
    expect(view.title).toBeUndefined()
    expect(view.detail).toBe('Claims to be "X".\n- Store files')
  })

  it('keeps a title or a detail that says more than the origin', () => {
    const view = viewOf('abc', normaliseSpec(spec({ origin: 'https://a.example', title: 'Install', detail: 'From https://a.example today' })))
    expect(view).toMatchObject({ title: 'Install', detail: 'From https://a.example today' })
  })

  it('leaves a page question and a spec with no origin as written', () => {
    const page = viewOf('abc', normaliseSpec(spec({ kind: 'page-alert', origin: 'https://a.example', title: 'https://a.example', detail: 'https://a.example' })))
    expect(page).toMatchObject({ title: 'https://a.example', detail: 'https://a.example' })
    const bare = viewOf('abc', normaliseSpec(spec({ title: 'https://a.example', detail: 'https://a.example' })))
    expect(bare).toMatchObject({ title: 'https://a.example', detail: 'https://a.example' })
  })

  it('leaves the spec itself whole, so the native box still names the origin', () => {
    const origin = 'https://a.example'
    const whole = normaliseSpec(spec({ origin, title: origin, detail: `x\n${origin}` }))
    viewOf('abc', whole)
    expect(whole).toMatchObject({ title: origin, detail: `x\n${origin}` })
  })
})

describe('double-press buttons', () => {
  it('keeps the indexes of buttons that exist, and makes each of them guarded', () => {
    const spec = normaliseSpec({ kind: 'consent', message: 'm', buttons: ['Allow', 'No'], cancelId: 1, doublePress: [0, 7, -1, 0.5] })
    expect(spec.doublePress).toEqual([0])
    expect(spec.guarded).toEqual([0])
  })

  it('reaches the panel as a list and a window, empty when the question has none', () => {
    const spec = normaliseSpec({ kind: 'consent', message: 'm', buttons: ['Allow', 'No'], cancelId: 1, doublePress: [0] })
    expect(viewOf('id', spec)).toMatchObject({ doublePress: [0], doublePressMs: 1500 })
    expect(viewOf('id', normaliseSpec({ kind: 'notice', message: 'm', buttons: ['OK'], cancelId: 0 })).doublePress).toEqual([])
  })
})
