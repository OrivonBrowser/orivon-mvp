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
})
