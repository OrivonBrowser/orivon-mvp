import { describe, expect, it } from 'vitest'
import { gridStep, isPickerView } from '../view.js'

const card = { id: 'c1', label: 'Tab', sub: null, thumb: null, icon: null, self: false }
const view = {
  id: 'q', title: 'Choose what to share with a.example', segments: ['tab', 'window', 'screen'], segment: 'tab',
  cards: { tab: [card], window: [], screen: [] }, modes: { window: 'list', screen: 'list' }, permissionText: 'x',
  audio: { tab: true, system: false, systemDefault: false }, selected: null, guardMs: 500
}

describe('isPickerView', () => {
  it('accepts what main sends', () => {
    expect(isPickerView(view)).toBe(true)
    expect(isPickerView({ ...view, segments: ['tab', 'window'], modes: { window: 'portal', screen: 'permission' }, selected: 'c1' })).toBe(true)
  })

  it.each([
    ['nothing', undefined], ['no id', { ...view, id: undefined }], ['no segments', { ...view, segments: [] }],
    ['a segment that is not offered', { ...view, segment: 'screen', segments: ['tab'] }], ['a foreign segment', { ...view, segments: ['tab', 'monitor'] }],
    ['a card without a label', { ...view, cards: { ...view.cards, tab: [{ ...card, label: undefined }] } }],
    ['missing cards', { ...view, cards: { tab: [] } }], ['a foreign mode', { ...view, modes: { window: 'list', screen: 'x' } }],
    ['no audio', { ...view, audio: undefined }], ['no guard', { ...view, guardMs: undefined }]
  ])('refuses %s', (_name, value) => {
    expect(isPickerView(value)).toBe(false)
  })
})

describe('gridStep', () => {
  it('moves by one card across and by a row down, holding at the ends', () => {
    expect(gridStep(7, 0, 'ArrowRight')).toBe(1)
    expect(gridStep(7, 6, 'ArrowRight')).toBe(6)
    expect(gridStep(7, 0, 'ArrowLeft')).toBe(0)
    expect(gridStep(7, 1, 'ArrowDown')).toBe(4)
    expect(gridStep(7, 4, 'ArrowDown')).toBe(4)
    expect(gridStep(7, 4, 'ArrowUp')).toBe(1)
    expect(gridStep(7, 1, 'ArrowUp')).toBe(1)
  })

  it('goes to the first card when nothing is selected, and to the ends on Home and End', () => {
    expect(gridStep(5, null, 'ArrowDown')).toBe(0)
    expect(gridStep(5, 3, 'Home')).toBe(0)
    expect(gridStep(5, 1, 'End')).toBe(4)
  })

  it('has no card to go to in an empty grid, and ignores other keys', () => {
    expect(gridStep(0, null, 'ArrowRight')).toBeNull()
    expect(gridStep(5, 2, 'a')).toBe(2)
  })
})
