import { describe, expect, it } from 'vitest'
import { DEFAULT_ENDPOINTS } from '../endpoints.js'
import { effectiveEthServers } from '../eth-servers.js'
import { EthServersSource } from '../eth-servers-source.js'
import type { EthServerValues } from '../eth-servers.js'

const A = 'https://rpc.example.com/a'
const B = 'http://192.168.1.20:8545'

function source (): { source: EthServersSource, set: (values: EthServerValues) => void } {
  let values: EthServerValues = { choice: 'orivon', rpcs: '', beacon: '' }
  const made = new EthServersSource()
  made.configure(() => effectiveEthServers(values))
  return { source: made, set: (next) => { values = next } }
}

describe('EthServersSource', () => {
  it('is Orivon\'s servers until it is told where to read', () => {
    expect(new EthServersSource().current().executionRpcs).toEqual(DEFAULT_ENDPOINTS.executionRpcs)
  })

  it('reads the settings each time, so a change is seen at once', () => {
    const { source: made, set } = source()
    set({ choice: 'custom', rpcs: A, beacon: '' })
    expect(made.current().executionRpcs).toEqual([A])
  })

  it('says a change is one when it differs from what the host was built with, and again only after another', () => {
    const { source: made, set } = source()
    made.forHost()
    set({ choice: 'custom', rpcs: A, beacon: '' })
    expect(made.changed()).toBe(true)
    expect(made.changed()).toBe(false)
    set({ choice: 'custom', rpcs: `${A}\n${B}`, beacon: '' })
    expect(made.changed()).toBe(true)
  })

  it('does not call an edit a change while Orivon\'s servers are chosen, or when the list comes out the same', () => {
    const { source: made, set } = source()
    made.forHost()
    set({ choice: 'orivon', rpcs: A, beacon: '' })
    expect(made.changed()).toBe(false)
    set({ choice: 'custom', rpcs: A, beacon: '' })
    made.forHost()
    set({ choice: 'custom', rpcs: A, beacon: '' })
    expect(made.changed()).toBe(false)
  })

  it('calls the first change a change when no host has been built yet, which a sleeping host takes as nothing to do', () => {
    const { source: made, set } = source()
    set({ choice: 'custom', rpcs: A, beacon: '' })
    expect(made.changed()).toBe(true)
  })

  it('sees the choice going back to Orivon\'s as a change', () => {
    const { source: made, set } = source()
    set({ choice: 'custom', rpcs: A, beacon: '' })
    made.forHost()
    set({ choice: 'orivon', rpcs: A, beacon: '' })
    expect(made.changed()).toBe(true)
  })
})
