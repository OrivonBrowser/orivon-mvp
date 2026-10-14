import { describe, expect, it } from 'vitest'
import { ownLoopbackPortCheck } from '../own-loopback-ports.js'

describe('ownLoopbackPortCheck', () => {
  it('holds the verifier, every node port and every route front, and nothing else', () => {
    const nodes = new Set([24001])
    const fronts = new Set([25001])
    const held = ownLoopbackPortCheck({ verifier: () => 23001, nodes: () => nodes, routeFront: (port) => fronts.has(port) })

    expect([23001, 24001, 25001].map(held)).toEqual([true, true, true])
    expect([23002, 24002, 25002, 80].map(held)).toEqual([false, false, false, false])
  })

  it('reads its sources on every call', () => {
    const nodes = new Set<number>()
    const held = ownLoopbackPortCheck({ verifier: () => 23001, nodes: () => nodes, routeFront: () => false })

    expect(held(24001)).toBe(false)
    nodes.add(24001)
    expect(held(24001)).toBe(true)
  })
})
