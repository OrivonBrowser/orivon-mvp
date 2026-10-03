import { describe, expect, it, vi } from 'vitest'
import { createArrivalWatch } from '../drag-arrival.js'

type Listener = (event: { clientX: number, clientY: number }) => void

function fakeTarget () {
  const listeners = new Map<string, Set<Listener>>()
  return {
    target: {
      addEventListener: (type: string, listener: Listener) => { listeners.set(type, (listeners.get(type) ?? new Set()).add(listener)) },
      removeEventListener: (type: string, listener: Listener) => { listeners.get(type)?.delete(listener) }
    },
    fire: (type: string, clientX: number, clientY: number) => { for (const listener of [...(listeners.get(type) ?? [])]) listener({ clientX, clientY }) },
    count: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0)
  }
}

describe('the arrival watch', () => {
  it('reports the first place the pointer shows up, once, and stops listening', () => {
    const { target, fire, count } = fakeTarget()
    const report = vi.fn()
    const watch = createArrivalWatch(target, report)
    watch.listen(true)
    fire('pointerover', 150, 20)
    fire('pointermove', 160, 22)
    expect(report.mock.calls).toEqual([[150, 20]])
    expect(count()).toBe(0)
  })

  it('reports nothing when told the drag is over first', () => {
    const { target, fire, count } = fakeTarget()
    const report = vi.fn()
    const watch = createArrivalWatch(target, report)
    watch.listen(true)
    watch.listen(false)
    fire('pointermove', 1, 1)
    expect(report).not.toHaveBeenCalled()
    expect(count()).toBe(0)
  })

  it('listens again for the next drag, and does not stack listeners when told twice', () => {
    const { target, fire, count } = fakeTarget()
    const report = vi.fn()
    const watch = createArrivalWatch(target, report)
    watch.listen(true)
    watch.listen(true)
    expect(count()).toBe(2)
    fire('pointermove', 5, 6)
    watch.listen(true)
    fire('pointerover', 7, 8)
    expect(report.mock.calls).toEqual([[5, 6], [7, 8]])
  })
})
