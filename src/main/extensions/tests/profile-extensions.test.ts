import { describe, expect, it, vi } from 'vitest'
import type { Extension } from 'electron'
import { createProfileExtensions } from '../profile-extensions.js'
import type { SessionExtensions } from '../profile-extensions.js'

type Listener = (event: unknown, extension: Extension) => void

function fakeExtensions (initial: Extension[] = [], damaged: readonly string[] = []) {
  const held = new Map(initial.map((extension) => [extension.id, extension]))
  const listeners: Record<string, Listener[]> = { 'extension-loaded': [], 'extension-unloaded': [] }
  const log: string[] = []
  let gate: Promise<void> = Promise.resolve()
  const session: SessionExtensions = {
    getAllExtensions: () => [...held.values()],
    loadExtension: async (path) => {
      if (damaged.includes(path)) throw new Error('damaged')
      await gate
      const extension = { id: path.split('/').pop() as string, path, name: path } as Extension
      log.push(`load ${path}`)
      held.set(extension.id, extension)
      for (const listener of listeners['extension-loaded'] ?? []) listener({}, extension)
      return extension
    },
    removeExtension: (id) => { log.push(`remove ${id}`); held.delete(id) },
    getExtension: (id) => held.get(id) ?? null,
    on: ((event: 'extension-loaded' | 'extension-unloaded', listener: Listener) => { listeners[event]?.push(listener) }) as SessionExtensions['on']
  }
  return {
    session,
    log,
    held,
    emit: (event: 'extension-loaded' | 'extension-unloaded', extension: Extension) => { for (const listener of listeners[event] ?? []) listener({}, extension) },
    hold: (promise: Promise<void>) => { gate = promise }
  }
}

const settle = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 0)) }
const ext = (id: string): Extension => ({ id, path: `/p/${id}`, name: id } as Extension)

describe('the person\'s extensions in a profile session', () => {
  it('loads nothing until asked, then every extension of the source once', async () => {
    const source = fakeExtensions([ext('a'), ext('b')])
    const target = fakeExtensions()
    const mirror = createProfileExtensions(target.session, source.session)
    expect(target.log).toEqual([])
    await mirror.activate()
    await mirror.activate()
    expect(target.log).toEqual(['load /p/a', 'load /p/b'])
    expect(mirror.loaded()).toEqual(['a', 'b'])
    expect(mirror.isReady()).toBe(true)
  })

  it('follows the source\'s loading and unloading while on, and ignores them while off', async () => {
    const source = fakeExtensions([ext('a')])
    const target = fakeExtensions()
    const mirror = createProfileExtensions(target.session, source.session)
    await mirror.activate()
    source.held.set('c', ext('c'))
    source.emit('extension-loaded', ext('c'))
    source.held.delete('a')
    source.emit('extension-unloaded', ext('a'))
    await settle()
    await mirror.deactivate()
    source.held.set('d', ext('d'))
    source.emit('extension-loaded', ext('d'))
    await settle()
    await mirror.activate()
    expect(target.log).toEqual(['load /p/a', 'load /p/c', 'remove a', 'remove c', 'load /p/c', 'load /p/d'])
    expect(mirror.loaded()).toEqual(['c', 'd'])
  })

  it('removes every extension when switched off, and none stays that was still loading', async () => {
    const source = fakeExtensions([ext('a'), ext('b')])
    const target = fakeExtensions()
    let release: () => void = () => {}
    target.hold(new Promise<void>((resolve) => { release = resolve }))
    const mirror = createProfileExtensions(target.session, source.session)
    const activating = mirror.activate()
    await settle()
    const deactivating = mirror.deactivate()
    release()
    await activating
    await deactivating
    expect(mirror.isActive()).toBe(false)
    expect(mirror.loaded()).toEqual([])
    expect([...target.held.keys()], 'nothing is left in the session').toEqual([])
  })

  it('logs an extension that cannot be loaded and goes on with the rest', async () => {
    const source = fakeExtensions([ext('a'), ext('b')])
    const target = fakeExtensions([], ['/p/a'])
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const mirror = createProfileExtensions(target.session, source.session)
    await mirror.activate()
    expect(mirror.loaded()).toEqual(['b'])
  })

  it('never lets an extension read local files', async () => {
    const source = fakeExtensions([ext('a')])
    const target = fakeExtensions()
    const load = vi.spyOn(target.session, 'loadExtension')
    await createProfileExtensions(target.session, source.session).activate()
    expect(load).toHaveBeenCalledWith('/p/a', { allowFileAccess: false })
  })
})

describe('an extension that loads into the profile session by another way', () => {
  it('is removed at once while the copies are off, and counts among them while they are on', async () => {
    const source = fakeExtensions([ext('a')])
    const target = fakeExtensions()
    const mirror = createProfileExtensions(target.session, source.session)
    // The service-worker recovery reloads in place, outside the mirror: here, after the copies were switched off.
    target.held.set('late', ext('late'))
    target.emit('extension-loaded', ext('late'))
    expect(target.held.has('late'), 'removed, because the copies are off').toBe(false)

    await mirror.activate()
    target.held.set('reloaded', ext('reloaded'))
    target.emit('extension-loaded', ext('reloaded'))
    expect(mirror.loaded()).toContain('reloaded')
    await mirror.deactivate()
    expect(target.held.has('reloaded'), 'and it goes with the rest when they are switched off').toBe(false)
  })
})
