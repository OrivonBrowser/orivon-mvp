import { describe, expect, it, vi } from 'vitest'
import { tunnels } from '../settings/sections/tunnels.js'
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

const row = tunnels.rows.find((candidate) => candidate.id === 'route-nym-privacy') as Row

describe('the Nym privacy row', () => {
  it('is always shown: a site or app can be sent through Nym whichever tunnel is the default', async () => {
    expect(row.visible).toBeUndefined()
    expect(await loaded('nym')).toBeDefined()
    expect(await loaded('socks5')).toBeDefined()
  })

  it('chooses between the two levels, and says in a sentence each what it does', () => {
    expect(row.control).toMatchObject({ type: 'choice', key: 'network.nym.privacy', options: [{ value: 'balanced' }, { value: 'strongest' }] })
    expect(row.help).toContain('Balanced: uses little power. Someone watching your connection can see roughly when you are active, not what you do.')
    expect(row.help).toContain('Strongest: Nym\'s full protection, a steady stream of decoy traffic that hides when you are active. It uses about a third of a processor core for each open tunnel.')
  })
})
