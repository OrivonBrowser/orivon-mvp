import { describe, expect, it, vi } from 'vitest'
import { privacyNetworkRows } from '../settings/sections/privacy-network.js'
import { SettingsState } from '../settings/state.js'
import type { OrivonInternal } from '../shared/bridge.js'
import type { Row } from '../settings/model.js'

async function loaded (kind: string): Promise<SettingsState> {
  const request = vi.fn(async (domain: string) => {
    if (domain === 'settings') return await Promise.resolve({ descriptions: [], values: { 'network.route.kind': kind, 'network.nym.privacy': 'balanced' }, atStart: {} })
    return await Promise.resolve({})
  })
  const state = new SettingsState({ request, onEvent: () => () => {} } as unknown as OrivonInternal, [])
  await state.load()
  return state
}

const row = privacyNetworkRows.find((candidate) => candidate.id === 'route-nym-privacy') as Row

describe('the Nym privacy row', () => {
  it('is shown while Nym is the far end of the tunnel, and not for the person\'s own SOCKS5 address', async () => {
    expect(row.visible?.(await loaded('nym'))).toBe(true)
    expect(row.visible?.(await loaded('socks5'))).toBe(false)
  })

  it('chooses between the two levels, and says in a sentence each what it does', () => {
    expect(row.control).toMatchObject({ type: 'choice', key: 'network.nym.privacy', options: [{ value: 'balanced' }, { value: 'strongest' }] })
    expect(row.help).toContain('Balanced: uses little power. Someone watching your connection can see roughly when you are active, not what you do.')
    expect(row.help).toContain('Strongest: Nym\'s full protection, a steady stream of decoy traffic that hides when you are active. It uses about a third of a processor core for each open tunnel.')
  })
})
