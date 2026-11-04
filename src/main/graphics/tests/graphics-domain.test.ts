import { describe, expect, it } from 'vitest'
import { graphicsDomain } from '../graphics-domain.js'
import type { InternalCaller } from '../../pages/internal-ipc.js'

const CALLER = {} as unknown as InternalCaller
const REVERT = { at: '2026-11-04T10:00:00.000Z', why: 'no-window' } as const

describe('the graphics domain', () => {
  it('is for the Settings page only', () => {
    expect(graphicsDomain(() => ({ offered: false, revert: null })).pages).toEqual(['settings'])
  })

  it('answers whether to offer the choice and the last revert, from main\'s own state', () => {
    let offer: { offered: boolean, revert: typeof REVERT | null } = { offered: true, revert: null }
    const domain = graphicsDomain(() => offer)
    expect(domain.handle({ type: 'x11Vulkan' }, CALLER)).toEqual({ offered: true, revert: null })
    offer = { offered: false, revert: REVERT }
    expect(domain.handle({ type: 'x11Vulkan' }, CALLER)).toEqual({ offered: false, revert: REVERT })
  })

  it('answers nothing to any other command', () => {
    const domain = graphicsDomain(() => ({ offered: true, revert: null }))
    for (const command of [undefined, null, 'x11Vulkan', {}, { type: 'set', key: 'graphics.webgpuOnX11', value: true }]) expect(domain.handle(command, CALLER)).toBeUndefined()
  })
})
