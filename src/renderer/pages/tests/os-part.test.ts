import { describe, expect, it, vi } from 'vitest'
import { OsPart } from '../settings/os-part.js'
import { SETTINGS_PARTS } from '../settings/settings-parts.js'
import type { OrivonInternal } from '../shared/bridge.js'

function part (replies: unknown[]): { part: OsPart, request: ReturnType<typeof vi.fn>, redraws: () => number } {
  let redraws = 0
  const request = vi.fn(async () => replies.shift())
  const bridge = { request } as unknown as OrivonInternal
  return { part: new OsPart(bridge, () => { redraws += 1 }), request, redraws: () => redraws }
}

describe('the os Settings part', () => {
  it('is registered under its name', () => {
    expect(SETTINGS_PARTS.map((def) => def.name)).toContain('os')
  })

  it('asks for the default-browser state once, and shows it', async () => {
    const { part: p, request } = part([{ state: 'can-set' }])
    expect(p.view).toBe('loading')
    await p.load()
    expect(p.view).toBe('can-set')
    expect(request).toHaveBeenCalledWith('os', { type: 'defaultBrowser' })
  })

  it('reads an answer that is not one of main\'s as "unavailable", so no button offers a change that cannot happen', async () => {
    for (const reply of [undefined, null, {}, { state: 'maybe' }, 'default']) {
      const { part: p } = part([reply])
      await p.load()
      expect(p.view, JSON.stringify(reply)).toBe('unavailable')
    }
  })

  it('becomes the default after a press that worked, redrawing while it waits and when it is done', async () => {
    const { part: p, request, redraws } = part([{ state: 'can-set' }, { state: 'default', ok: true }])
    await p.load()
    const pressed = p.makeDefault()
    expect(p.busy).toBe(true)
    await pressed
    expect(p.busy).toBe(false)
    expect(p.view).toBe('default')
    expect(p.declined).toBe(false)
    expect(request).toHaveBeenLastCalledWith('os', { type: 'makeDefault' })
    expect(redraws()).toBe(2)
  })

  it('stops waiting and says it did not happen when main fails to answer', async () => {
    const request = vi.fn(async (_domain: string, command: { type: string }) => {
      if (command.type === 'makeDefault') throw new Error('main failed')
      return await Promise.resolve({ state: 'can-set' })
    })
    const p = new OsPart({ request } as unknown as OrivonInternal, () => {})
    await p.load()
    await p.makeDefault()
    expect(p.busy).toBe(false)
    expect(p.declined).toBe(true)
    expect(p.view).toBe('can-set')
  })

  it('says the system declined when it is still not the default afterwards', async () => {
    const { part: p } = part([{ state: 'can-set' }, { state: 'can-set', ok: false }])
    await p.load()
    await p.makeDefault()
    expect(p.view).toBe('can-set')
    expect(p.declined).toBe(true)
  })

  it('takes one press at a time', async () => {
    const { part: p, request } = part([{ state: 'can-set' }, { state: 'default' }])
    await p.load()
    const first = p.makeDefault()
    await p.makeDefault()
    await first
    expect(request.mock.calls.filter((call) => (call[1] as { type: string }).type === 'makeDefault')).toHaveLength(1)
  })
})
