import { describe, expect, it, vi } from 'vitest'
import type { OrivonInternal } from '../shared/bridge.js'
import { PageState } from '../extensions/state.js'
import { CARD_BADGES, DETAIL_SECTIONS, EXTENSION_VIEWS } from '../extensions/registry.js'

function fake (replies: Record<string, unknown>): { bridge: OrivonInternal, requests: unknown[], emit: (topic: string, payload: unknown) => void } {
  const requests: unknown[] = []
  let listener: (topic: string, payload: unknown) => void = () => {}
  const bridge = {
    page: 'extensions',
    platform: 'linux',
    request: async (domain: string, command: { type: string }) => { requests.push({ domain, ...command }); return replies[`${domain}.${command.type}`] },
    onEvent: (next: typeof listener) => { listener = next; return () => {} }
  } as unknown as OrivonInternal
  return { bridge, requests, emit: (topic, payload) => { listener(topic, payload) } }
}

describe('PageState', () => {
  it('learns whether this is a private runtime and whether Developer mode is on', async () => {
    const { bridge } = fake({ 'extensions.context': { isPrivate: true }, 'settings.get': { values: { 'extensions.developerMode': true } } })
    const state = new PageState(bridge)
    await state.load()
    expect(state.isPrivate).toBe(true)
    expect(state.developerMode).toBe(true)
  })

  it('takes a refused context to mean an ordinary runtime', async () => {
    const { bridge } = fake({ 'settings.get': { values: {} } })
    const state = new PageState(bridge)
    await state.load()
    expect(state.isPrivate).toBe(false)
    expect(state.developerMode).toBe(false)
  })

  it('sends a request to the extensions domain with the type first', async () => {
    const { bridge, requests } = fake({ 'settings.get': { values: {} } })
    const state = new PageState(bridge)
    await state.request('remove', { id: 'a', type: 'ignored' })
    expect(requests).toEqual([{ domain: 'extensions', id: 'a', type: 'remove' }])
  })

  it('tells listeners when the registry or Developer mode changed, and nothing else', async () => {
    const { bridge, emit } = fake({ 'settings.get': { values: {} } })
    const state = new PageState(bridge)
    await state.load()
    const heard = vi.fn()
    state.onChange(heard)
    emit('extensions.changed', undefined)
    emit('settings.changed', { key: 'extensions.developerMode', value: true })
    emit('settings.changed', { key: 'appearance.theme', value: 'dark' })
    expect(heard).toHaveBeenCalledTimes(2)
    expect(state.developerMode).toBe(true)
  })
})

describe('the registry', () => {
  it('has a view for every place', () => {
    expect(Object.keys(EXTENSION_VIEWS).sort()).toEqual(['details', 'errors', 'list', 'shortcuts'])
  })

  it('starts the details view with the about section at order 10, with unique ids', () => {
    expect(DETAIL_SECTIONS[0]).toMatchObject({ id: 'about', order: 10 })
    expect(new Set(DETAIL_SECTIONS.map((section) => section.id)).size).toBe(DETAIL_SECTIONS.length)
    expect(CARD_BADGES).toEqual([])
  })
})
