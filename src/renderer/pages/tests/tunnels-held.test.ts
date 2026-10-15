import { describe, expect, it, vi } from 'vitest'
import { HELD_LINE, heldNote, tunnels } from '../settings/sections/tunnels.js'
import { toggleState } from '../settings/rows.js'
import { SettingsState } from '../settings/state.js'
import type { Control, Row } from '../settings/model.js'
import type { OrivonInternal } from '../shared/bridge.js'

async function loaded (held: readonly string[], tunnel?: 'nym'): Promise<SettingsState> {
  const request = vi.fn(async (domain: string) => {
    if (domain === 'settings') return await Promise.resolve({ descriptions: [], values: { 'network.route.kind': 'nym', 'network.tunnel.everywhere': true, 'network.nym.enabled': true }, atStart: {}, held })
    if (domain === 'profiles') return await Promise.resolve({ profiles: [], isPrivate: held.length > 0, ...(tunnel === undefined ? {} : { tunnel }) })
    return await Promise.resolve({})
  })
  const state = new SettingsState({ request, onEvent: () => () => {} } as unknown as OrivonInternal, [])
  await state.load()
  return state
}

const row = (id: string): Row => tunnels.rows.find((candidate) => candidate.id === id) as Row
const HELD = ['network.tunnel.everywhere', 'network.route.kind', 'network.nym.enabled']

describe('the Tunnels section of a private window that always goes through Nym', () => {
  it('shows the browser-wide switch on and fixed, the tunnel choice fixed, and "Let Nym run" on and fixed', async () => {
    const state = await loaded(HELD, 'nym')
    const everywhere = row('route-everywhere').control as Extract<Control, { type: 'toggle' }>
    expect(toggleState(everywhere, state)).toEqual({ checked: true, disabled: true })
    const nym = row('route-nym-enabled').control as Extract<Control, { type: 'toggle' }>
    expect(toggleState(nym, state)).toEqual({ checked: true, disabled: true })
    const kind = row('route-kind').control as Extract<Control, { type: 'choice' }>
    expect(kind.locked?.(state)).toBe(true)
  })

  it('says why, in one line, under each of the three', async () => {
    const state = await loaded(HELD, 'nym')
    expect(heldNote(state)).toBe(HELD_LINE)
    expect(HELD_LINE).toContain('always goes through Nym')
    for (const id of ['route-kind', 'route-everywhere', 'route-nym-enabled']) expect(row(id).below, id).toBeDefined()
  })

  it('leaves them free in any other window', async () => {
    const state = await loaded([])
    const everywhere = row('route-everywhere').control as Extract<Control, { type: 'toggle' }>
    expect(toggleState(everywhere, state)).toEqual({ checked: true, disabled: false })
    expect((row('route-kind').control as Extract<Control, { type: 'choice' }>).locked?.(state)).toBe(false)
    expect(heldNote(state)).toBeNull()
  })

  it('keeps the held values when everything is reset', async () => {
    const state = await loaded(HELD, 'nym')
    await state.resetAll()
    expect(state.value('network.tunnel.everywhere')).toBe(true)
    expect(state.value('network.route.kind')).toBe('nym')
  })
})
