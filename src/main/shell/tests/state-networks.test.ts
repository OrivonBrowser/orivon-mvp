import { describe, expect, it, vi } from 'vitest'
import { SHELL_STATE_PARTS } from '../shell-state-parts.js'
import { networksStatePart } from '../state/networks.js'
import type { WindowContext } from '../window-context.js'

function rig (dot: 'green' | 'amber' | 'red' | 'none') {
  const listeners = new Set<() => void>()
  const networks = { dot: vi.fn(() => dot), onChange: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } }
  return { ctx: { services: { networks } } as unknown as WindowContext, listeners, networks }
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

  it('pushes when a node or a switch changes, and stops when the window does', () => {
    const { ctx, listeners } = rig('none')
    const push = vi.fn()
    const stop = networksStatePart.watch?.(ctx, push)
    for (const listener of listeners) listener()
    expect(push).toHaveBeenCalledTimes(1)
    stop?.()
    expect(listeners.size).toBe(0)
  })
})
