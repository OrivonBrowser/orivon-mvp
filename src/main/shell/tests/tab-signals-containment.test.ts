import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyTabSignals, signalState, wireTabSignals } from '../tab-signals.js'
import type { TabSignal } from '../tab-signals.js'
import type { TabRecord } from '../tab-types.js'

const record = { view: { webContents: {} } } as unknown as TabRecord
const boom = (): never => { throw new Error('boom') }

afterEach(() => { vi.restoreAllMocks() })

describe('a tab signal that throws', () => {
  it('is logged by name in wire and apply, and the signals after it still run', () => {
    const complaint = vi.spyOn(console, 'error').mockImplementation(() => {})
    const wire = vi.fn()
    const apply = vi.fn()
    const signals: TabSignal[] = [{ name: 'broken', wire: boom, apply: boom }, { name: 'fine', wire, apply }]

    expect(() => { wireTabSignals('t1', record, signals) }).not.toThrow()
    expect(() => { applyTabSignals('t1', record, signals) }).not.toThrow()

    expect(wire).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledTimes(2)
    expect(complaint).toHaveBeenCalledTimes(3)
    expect(complaint.mock.calls.every((call) => String(call[0]).includes('broken'))).toBe(true)
  })

  it('adds nothing to a tab\'s state, while the other signals still do', () => {
    const complaint = vi.spyOn(console, 'error').mockImplementation(() => {})
    const signals: TabSignal[] = [{ name: 'broken', state: boom }, { name: 'audio', state: () => ({ muted: true }) }]

    expect(signalState(record, undefined, signals)).toEqual({ muted: true })
    expect(String(complaint.mock.calls[0]?.[0])).toContain('broken')
  })
})
