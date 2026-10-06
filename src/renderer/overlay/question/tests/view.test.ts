import { describe, expect, it } from 'vitest'
import { displayOrder, isPageQuestion, isQuestionView, primaryIndex } from '../view.js'

const view = {
  id: 'abc', kind: 'consent', title: undefined, message: 'Allow?', detail: undefined, warning: false, origin: undefined,
  buttons: ['Allow', 'Cancel'], cancelId: 1, guarded: [0], doublePress: [], doublePressMs: 1500, focus: 'dialog', input: undefined, checkboxLabel: undefined, guardMs: 500
}

describe('isQuestionView', () => {
  it('accepts what main sends', () => {
    expect(isQuestionView(view)).toBe(true)
    expect(isQuestionView({ ...view, doublePress: [0] })).toBe(true)
    expect(isQuestionView({ ...view, kind: 'page-prompt', input: { initial: 'x', max: 100_000 }, checkboxLabel: 'Stop', title: 't', detail: 'd', origin: 'https://a.example', focus: 0 })).toBe(true)
  })

  it.each([
    ['nothing', undefined], ['a string', 'ask'], ['no id', { ...view, id: undefined }], ['a kind it does not know', { ...view, kind: 'grant' }],
    ['no buttons', { ...view, buttons: [] }], ['a button that is not text', { ...view, buttons: ['a', 1] }], ['no guard length', { ...view, guardMs: undefined }],
    ['a guarded list of text', { ...view, guarded: ['0'] }], ['a focus it does not know', { ...view, focus: 'button' }], ['an input without its initial text', { ...view, input: {} }],
    ['a warning that is not a boolean', { ...view, warning: 'yes' }],
    ['a double-press list of text', { ...view, doublePress: ['0'] }], ['no double-press window', { ...view, doublePressMs: undefined }]
  ])('refuses %s', (_name, value) => {
    expect(isQuestionView(value)).toBe(false)
  })
})

describe('displayOrder and primaryIndex', () => {
  it('puts the way out first and keeps the rest in order', () => {
    expect(displayOrder(['Allow', 'Cancel'], 1)).toEqual([1, 0])
    expect(displayOrder(['A', 'B', 'C'], 2)).toEqual([2, 0, 1])
    expect(displayOrder(['OK'], 0)).toEqual([0])
  })

  it('gives the strongest style to the first button that is not the way out', () => {
    expect(primaryIndex(['Allow', 'Cancel'], 1)).toBe(0)
    expect(primaryIndex(['Cancel', 'Add'], 0)).toBe(1)
    expect(primaryIndex(['OK'], 0)).toBe(-1)
  })

  it('does not lose a button when the way out is out of range', () => {
    expect(displayOrder(['A', 'B'], 9)).toEqual([0, 1])
  })
})

describe('isPageQuestion', () => {
  it('is true for what a page raised and false for what the browser asks', () => {
    expect(isPageQuestion('page-alert')).toBe(true)
    expect(isPageQuestion('consent')).toBe(false)
    expect(isPageQuestion('notice')).toBe(false)
  })
})
