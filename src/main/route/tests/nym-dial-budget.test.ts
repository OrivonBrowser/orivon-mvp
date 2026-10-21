// The broker's deadline over a routed app's connection must let the Nym host finish what it promises, and the preload's budget
// for the call must outlast the broker's, or the app is told "took too long" before the broker can say why.

import { describe, expect, it, vi } from 'vitest'
import { NYM_CONNECT_TIMEOUT_MS, NYM_DIAL_BUDGET_MS, createNymProvider } from '../nym-provider.js'
import { DEFAULT_START_WAIT_MS } from '../../../protocols/nym-tunnel/instances.js'
import { CONNECT_TIMEOUT_MS } from '../../../protocols/nym-tunnel/socks-server.js'
import { DIAL_TIMEOUT_MS } from '../../../broker/adapters/node-adapters.js'

vi.mock('electron', () => ({ ipcRenderer: { invoke: vi.fn() } }))
const { TIMEOUT_MS } = await import('../../../preload/surface/control-call.js')

describe('the dial budget of a routed app on Nym', () => {
  it('is declared by the provider, and is longer than the direct dial\'s', () => {
    const provider = createNymProvider({ ensure: async () => { throw new Error('unused') } }, 'user')
    expect(provider.dialBudgetMs).toBe(NYM_DIAL_BUDGET_MS)
    expect(NYM_DIAL_BUDGET_MS).toBeGreaterThan(DIAL_TIMEOUT_MS)
  })

  it('covers a tunnel that comes up on its last attempt and a stream that opens on its last second', () => {
    expect(NYM_DIAL_BUDGET_MS).toBeGreaterThanOrEqual(NYM_CONNECT_TIMEOUT_MS)
    expect(NYM_CONNECT_TIMEOUT_MS).toBeGreaterThanOrEqual(DEFAULT_START_WAIT_MS)
    expect(NYM_CONNECT_TIMEOUT_MS).toBeGreaterThanOrEqual(CONNECT_TIMEOUT_MS)
  })

  it('is outlasted by the preload\'s budget for a net call', () => {
    expect(TIMEOUT_MS.net).toBeGreaterThan(NYM_DIAL_BUDGET_MS)
  })
})
