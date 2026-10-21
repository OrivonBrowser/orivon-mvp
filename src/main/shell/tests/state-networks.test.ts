import { describe, expect, it, vi } from 'vitest'
import { SHELL_STATE_PARTS } from '../shell-state-parts.js'
import { networksStatePart } from '../state/networks.js'
import type { WindowContext } from '../window-context.js'

type DotName = 'green' | 'amber' | 'red' | 'none'

function rig (initial: DotName) {
  let dot = initial
  const listeners = new Set<() => void>()
  const networks = { dot: vi.fn(() => dot), onChange: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } }
  const change = (next?: DotName): void => { if (next !== undefined) dot = next; for (const listener of [...listeners]) listener() }
  return { ctx: { services: { networks } } as unknown as WindowContext, listeners, networks, change }
}

describe('the networks state part', () => {
  it('is one of the window state parts', () => {
    expect(SHELL_STATE_PARTS.map((part) => part.name)).toContain('networks')
  })

  it('says the dot the nodes call for, from memory', () => {
    for (const dot of ['green', 'amber', 'red', 'none'] as const) {
      const { ctx } = rig(dot)
      expect(networksStatePart.read(ctx, {} as never)).toEqual({ networksDot: dot })
    }
  })

  it('pushes when a node or a switch changes the dot, and stops when the window does', () => {
    const { ctx, listeners, change } = rig('none')
    const push = vi.fn()
    const stop = networksStatePart.watch?.(ctx, push)
    change('amber')
    expect(push).toHaveBeenCalledTimes(1)
    stop?.()
    expect(listeners.size).toBe(0)
  })

  it('pushes nothing for a change that leaves the dot where it was, such as every step of a tunnel coming up', () => {
    const { ctx, change } = rig('none')
    const push = vi.fn()
    networksStatePart.watch?.(ctx, push)
    for (let step = 0; step < 6; step++) change()
    expect(push).not.toHaveBeenCalled()
    change('green')
    change()
    change('none')
    expect(push).toHaveBeenCalledTimes(2)
  })
})
