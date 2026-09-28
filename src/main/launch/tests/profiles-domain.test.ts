import { describe, expect, it, vi } from 'vitest'
import type { InternalCaller } from '../../pages/internal-ipc.js'
import { profilesDomain } from '../profiles-domain.js'
import type { ProfilesService } from '../profiles-service.js'

const CALLER = {} as InternalCaller

function setup (isPrivate = false): { call: (command: unknown) => unknown, service: Record<string, ReturnType<typeof vi.fn>> } {
  const service = {
    isPrivate,
    list: vi.fn(() => [{ id: 'default', name: 'Default' }]),
    create: vi.fn(() => ({ ok: true })),
    rename: vi.fn(() => ({ ok: true })),
    setColor: vi.fn(() => ({ ok: true })),
    remove: vi.fn(() => ({ ok: true })),
    open: vi.fn(() => true),
    openPrivate: vi.fn()
  }
  const domain = profilesDomain(service as unknown as ProfilesService)
  return { call: (command) => domain.handle(command, CALLER), service: service as never }
}

describe('the profiles domain', () => {
  it('is for the pages that manage profiles, Settings, and the Private page', () => {
    expect(profilesDomain({} as ProfilesService).pages).toEqual(['profiles', 'private', 'settings'])
  })

  it('lists the profiles with the colours there are, and says whether this is a private window', () => {
    const { call } = setup()
    expect(call({ type: 'list' })).toMatchObject({ profiles: [{ id: 'default' }], colors: expect.arrayContaining(['blue', 'purple']), isPrivate: false })
    expect(setup(true).call({ type: 'list' })).toMatchObject({ isPrivate: true })
  })

  it('passes a change on to the service, with the id only when it is text', () => {
    const { call, service } = setup()
    call({ type: 'create', name: 'Work', color: 'green' })
    call({ type: 'rename', id: 'a1', name: 'Office' })
    call({ type: 'color', id: 'a1', color: 'red' })
    call({ type: 'remove', id: 'a1' })
    call({ type: 'rename', id: 7, name: 'x' })
    expect(service['create']).toHaveBeenCalledWith('Work', 'green')
    expect(service['rename']).toHaveBeenNthCalledWith(1, 'a1', 'Office')
    expect(service['rename']).toHaveBeenNthCalledWith(2, '', 'x')
    expect(service['setColor']).toHaveBeenCalledWith('a1', 'red')
    expect(service['remove']).toHaveBeenCalledWith('a1')
  })

  it('opens a profile and starts a private window', () => {
    const { call, service } = setup()
    expect(call({ type: 'open', id: 'a1' })).toEqual({ ok: true })
    expect(call({ type: 'newPrivate' })).toEqual({ ok: true })
    expect(service['open']).toHaveBeenCalledWith('a1')
    expect(service['openPrivate']).toHaveBeenCalledTimes(1)
  })

  it('changes no profile from a private window, though it may look, open one and start another', () => {
    const { call, service } = setup(true)
    for (const type of ['create', 'rename', 'color', 'remove']) expect(call({ type, id: 'a1', name: 'x', color: 'blue' })).toEqual({ ok: false, reason: 'private' })
    for (const name of ['create', 'rename', 'setColor', 'remove']) expect(service[name]).not.toHaveBeenCalled()
    expect(call({ type: 'open', id: 'a1' })).toEqual({ ok: true })
    expect(call({ type: 'newPrivate' })).toEqual({ ok: true })
  })

  it('answers nothing to what it does not know', () => {
    const { call } = setup()
    expect(call({ type: 'wipe' })).toBeUndefined()
    expect(call('nonsense')).toBeUndefined()
    expect(call(null)).toBeUndefined()
  })
})
