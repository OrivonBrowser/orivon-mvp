import { describe, expect, it } from 'vitest'
import { SETTINGS } from '../../../main/settings/schema.js'
import { performanceSection } from '../settings/sections/performance.js'
import { memoryRows } from '../settings/sections/rows/memory.js'
import type { SettingsState } from '../settings/state.js'

const state = (saver: boolean): SettingsState => ({ value: (key: string) => key === 'performance.memorySaver' ? saver : undefined }) as unknown as SettingsState

describe('the Performance rows', () => {
  it('says what the section is for', () => {
    expect(performanceSection.intro).toBe('Orivon can free memory from tabs you are not using.')
    expect(performanceSection.rows).toEqual([...memoryRows])
  })

  it('keys its rows to settings that exist, and lists sites by a control of its own', () => {
    const keys = memoryRows.flatMap((row) => 'key' in row.control ? [row.control.key] : [])
    expect(keys).toEqual(['performance.memorySaver', 'performance.sleepAfter', 'performance.energySaver'])
    for (const key of keys) expect(Object.hasOwn(SETTINGS, key), key).toBe(true)
    expect(memoryRows.find((row) => row.id === 'keep-awake')?.control.type).toBe('custom')
  })

  it('shows the wait only while the memory saver is on', () => {
    const wait = memoryRows.find((row) => row.id === 'sleep-after')
    expect(wait?.visible?.(state(true))).toBe(true)
    expect(wait?.visible?.(state(false))).toBe(false)
  })

  it('is found by the words a person would search for', () => {
    const words = new Set(memoryRows.flatMap((row) => row.keywords ?? []))
    for (const word of ['memory', 'sleep', 'discard', 'suspend', 'tabs', 'battery', 'performance', 'ram']) expect(words.has(word), word).toBe(true)
  })

  it('puts the energy saver under its own heading, and offers Off and When on battery', () => {
    const energy = memoryRows.find((row) => row.id === 'energy-saver')
    expect(energy?.group).toBe('Energy')
    expect(energy?.help).toBe('On battery, tabs go to sleep after 5 minutes.')
    expect(energy?.control).toMatchObject({ type: 'choice', options: [{ value: 'off', label: 'Off' }, { value: 'battery', label: 'When on battery' }] })
  })
})
