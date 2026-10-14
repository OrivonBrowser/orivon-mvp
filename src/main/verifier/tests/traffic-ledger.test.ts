import { describe, expect, it } from 'vitest'
import { TrafficLedger } from '../traffic-ledger.js'

describe('the traffic the verifier host reports', () => {
  it('keeps the latest figures of a node it knows', () => {
    const ledger = new TrafficLedger(new Set(['ipfs-node']))
    ledger.record('ipfs-node', 2, 100)
    ledger.record('ipfs-node', 1, 150)
    expect(ledger.read('ipfs-node')).toEqual({ active: 1, bytes: 150 })
  })

  it('keeps nothing of a name it does not know', () => {
    const ledger = new TrafficLedger(new Set(['ipfs-node']))
    ledger.record('made-up', 9, 9_000)
    expect(ledger.read('made-up')).toEqual({ active: 0, bytes: 0 })
  })

  it('adds the bytes of a host that is gone to the total, and has nothing in flight after it', () => {
    const ledger = new TrafficLedger(new Set(['swarm-node']))
    ledger.record('swarm-node', 3, 400)
    ledger.fold()
    expect(ledger.read('swarm-node')).toEqual({ active: 0, bytes: 400 })
    ledger.record('swarm-node', 1, 50)
    expect(ledger.read('swarm-node')).toEqual({ active: 1, bytes: 450 })
  })
})
