import { describe, expect, it, vi } from 'vitest'
import { GraphicsPart, offerOf } from '../settings/graphics-part.js'
import { SETTINGS_PARTS } from '../settings/settings-parts.js'
import type { OrivonInternal } from '../shared/bridge.js'

const REVERT = { at: '2026-11-04T10:00:00.000Z', why: 'gpu-crash' }

function part (replies: unknown[]): { part: GraphicsPart, request: ReturnType<typeof vi.fn>, redraws: () => number } {
  let redraws = 0
  const request = vi.fn(async () => replies.shift())
  return { part: new GraphicsPart({ request } as unknown as OrivonInternal, () => { redraws += 1 }), request, redraws: () => redraws }
}

describe('offerOf', () => {
  it('reads what main says', () => {
    expect(offerOf({ offered: true, revert: REVERT })).toEqual({ offered: true, revert: REVERT })
    expect(offerOf({ offered: false, revert: null })).toEqual({ offered: false, revert: null })
  })

  it('offers nothing and reports no revert for an answer that is not main\'s', () => {
    for (const reply of [undefined, null, 'x', {}, { offered: 'yes' }, { offered: 1 }]) expect(offerOf(reply), JSON.stringify(reply)).toEqual({ offered: false, revert: null })
    expect(offerOf({ offered: true, revert: { at: 5, why: 'gpu-crash' } }).revert).toBeNull()
    expect(offerOf({ offered: true, revert: { at: REVERT.at, why: 'gpu-software' } }).revert?.why).toBe('gpu-software')
    expect(offerOf({ offered: true, revert: { at: REVERT.at, why: 'hunch' } }).revert).toBeNull()
  })
})

describe('the graphics Settings part', () => {
  it('is registered under its name', () => {
    expect(SETTINGS_PARTS.map((def) => def.name)).toContain('graphics')
  })

  it('asks once for the offer and the last revert', async () => {
    const { part: p, request } = part([{ offered: true, revert: REVERT }])
    expect(p.offered).toBe(false)
    await p.load()
    expect(p.offered).toBe(true)
    expect(p.revert).toEqual(REVERT)
    expect(request).toHaveBeenCalledWith('graphics', { type: 'x11Vulkan' })
  })

  it('reads the answer again and redraws when main says it changed, taking that event and no other', async () => {
    const { part: p, redraws } = part([{ offered: true, revert: null }, { offered: true, revert: REVERT }])
    await p.load()
    expect(p.handle('settings.changed')).toBe(false)
    expect(p.handle('graphics.changed')).toBe(true)
    await vi.waitFor(() => { expect(redraws()).toBe(1) })
    expect(p.revert).toEqual(REVERT)
  })
})
