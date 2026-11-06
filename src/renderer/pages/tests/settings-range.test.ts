import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderRange } from '../settings/rows.js'
import { newTabRows } from '../settings/sections/rows/new-tab.js'
import type { Control } from '../settings/model.js'
import type { SettingsState } from '../settings/state.js'

class FakeElement {
  className = ''
  id = ''
  type = ''
  min = ''
  max = ''
  step = ''
  value = ''
  textContent = ''
  dataset: Record<string, string> = {}
  attributes = new Map<string, string>()
  children: FakeElement[] = []
  private readonly listeners = new Map<string, () => void>()
  append (...children: FakeElement[]): void { this.children.push(...children) }
  setAttribute (name: string, value: string): void { this.attributes.set(name, value) }
  addEventListener (type: string, listener: () => void): void { this.listeners.set(type, listener) }
  fire (type: string): void { this.listeners.get(type)?.() }
}

afterEach(() => { vi.unstubAllGlobals() })

const control: Extract<Control, { type: 'range' }> = { type: 'range', key: 'appearance.newTabBrightness', step: 5, unit: '%' }

function setup (current: unknown, outcome: string | null = null) {
  vi.stubGlobal('document', { createElement: () => new FakeElement() })
  const set = vi.fn(async () => outcome)
  const state = {
    description: () => ({ kind: 'int', default: 100, min: 20, max: 180 }),
    value: () => current,
    set
  } as unknown as SettingsState
  const wrapper = renderRange(control, state, 'c1') as unknown as FakeElement
  const [input, readout] = wrapper.children as [FakeElement, FakeElement]
  return { input, readout, set }
}

const flush = async (): Promise<void> => { await new Promise((resolve) => { setTimeout(resolve, 0) }) }

describe('a range control', () => {
  it('is a slider over the setting\'s own bounds, in the control\'s steps, showing the saved value with its unit', () => {
    const { input, readout } = setup(60)
    expect(input).toMatchObject({ type: 'range', id: 'c1', min: '20', max: '180', step: '5', value: '60' })
    expect(readout.textContent).toBe('60%')
    expect(input.attributes.get('aria-valuetext')).toBe('60%')
    expect(readout.attributes.get('aria-hidden')).toBe('true')
  })

  it('shows the default while no value has arrived', () => {
    const { input, readout } = setup(undefined)
    expect(input.value).toBe('100')
    expect(readout.textContent).toBe('100%')
  })

  it('follows the thumb in its readout without saving anything', () => {
    const { input, readout, set } = setup(100)
    input.value = '135'
    input.fire('input')
    expect(readout.textContent).toBe('135%')
    expect(input.attributes.get('aria-valuetext')).toBe('135%')
    expect(set).not.toHaveBeenCalled()
  })

  it('saves the number once the person lets go, and counts the control as used', async () => {
    const { input, set } = setup(100)
    input.value = '45'
    input.fire('input')
    expect(input.dataset['settled']).toBeUndefined()
    input.fire('change')
    expect(set).toHaveBeenCalledExactlyOnceWith('appearance.newTabBrightness', 45)
    expect(input.dataset['settled']).toBe('true')
    await flush()
  })

  it('holds a redraw again as soon as the thumb moves after a save', () => {
    const { input } = setup(100)
    input.fire('change')
    expect(input.dataset['settled']).toBe('true')
    input.value = '90'
    input.fire('input')
    expect(input.dataset['settled']).toBeUndefined()
  })

  it('puts the saved value back when main refuses the new one', async () => {
    const { input, readout } = setup(100, 'That value is not allowed.')
    input.value = '45'
    input.fire('input')
    input.fire('change')
    await flush()
    expect(input.value).toBe('100')
    expect(readout.textContent).toBe('100%')
  })
})

describe('the New tab background brightness row', () => {
  const row = newTabRows.find((candidate) => candidate.id === 'new-tab-brightness')
  const choosing = (background: string): SettingsState => ({ value: (key: string) => key === 'appearance.newTabBackground' ? background : undefined }) as unknown as SettingsState

  it('follows the two picture rows, in the same group, as a slider in steps of five percent', () => {
    expect(newTabRows.map((candidate) => candidate.id)).toEqual(['new-tab-background', 'new-tab-background-choose', 'new-tab-brightness'])
    expect(row).toMatchObject({ label: 'Background brightness', group: 'New tab', control: { type: 'range', key: 'appearance.newTabBrightness', step: 5, unit: '%' } })
  })

  it('is found by the words a person would try', () => {
    for (const word of ['brightness', 'darker', 'lighter', 'dim', 'wallpaper']) expect(row?.keywords).toContain(word)
  })

  it('shows for either picture and hides when the page has none to dim', () => {
    expect(row?.visible?.(choosing('orivon'))).toBe(true)
    expect(row?.visible?.(choosing('custom'))).toBe(true)
    expect(row?.visible?.(choosing('none'))).toBe(false)
  })
})
