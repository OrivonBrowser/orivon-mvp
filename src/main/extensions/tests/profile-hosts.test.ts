import { describe, expect, it, vi } from 'vitest'
import type { Extension, Session } from 'electron'
import type { ElectronChromeExtensions } from 'orivon:crx-extensions'

vi.mock('../dnr-api.js', () => ({ registerDnrApiHandlers: () => ({ onRuleMatched: () => {}, onTabNavigated: () => {} }) }))
vi.mock('../dnr-webrequest.js', () => ({ installDnrWebRequestHandlers: () => {} }))

const { createProfileAttacher } = await import('../profile-hosts.js')
const { profileEntryOf } = await import('../profile-registry.js')

type Listener = (event: unknown, extension: Extension) => void

function fakeSession (initial: Extension[] = []): { session: Session, held: Map<string, Extension> } {
  const held = new Map(initial.map((extension) => [extension.id, extension]))
  const listeners: Record<string, Listener[]> = { 'extension-loaded': [], 'extension-unloaded': [] }
  const extensions = {
    getAllExtensions: () => [...held.values()],
    loadExtension: async (path: string) => {
      const extension = { id: path.split('/').pop() as string, path, name: path } as Extension
      held.set(extension.id, extension)
      for (const listener of listeners['extension-loaded'] ?? []) listener({}, extension)
      return extension
    },
    removeExtension: (id: string) => { held.delete(id) },
    getExtension: (id: string) => held.get(id) ?? null,
    on: (event: string, listener: Listener) => { listeners[event]?.push(listener) }
  }
  return { session: { extensions } as unknown as Session, held }
}

const ext = (id: string): Extension => ({ id, path: `/p/${id}`, name: id } as Extension)
const settle = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 0)) }

describe.each(['persist:tunnel-profile', 'persist:direct-profile'])('the extensions of %s follow the websites open in it', (partition) => {
  function setup () {
    const source = fakeSession([ext('a'), ext('b')])
    const target = fakeSession()
    const created: Session[] = []
    const attacher = createProfileAttacher({
      defaultSession: source.session,
      createHost: (session) => { created.push(session); return { getRouter: () => ({}), setBadgeText: () => {} } as unknown as ElectronChromeExtensions },
      installApis: () => {},
      userDataPath: '/unused',
      engine: () => undefined,
      tabs: {} as never
    })
    attacher.prepare(target.session, partition)
    const demand = profileEntryOf(target.session)!.demand
    return { attacher, target, demand, created }
  }

  it('loads nothing when prepared, and no instance is made twice', () => {
    const { attacher, target, created } = setup()
    attacher.prepare(target.session, partition)
    expect(created).toHaveLength(1)
    expect([...target.held.keys()]).toEqual([])
  })

  it('loads the copies for the first view and has them settled before the wait ends', async () => {
    const { attacher, target } = setup()
    await attacher.wake(target.session)
    expect([...target.held.keys()]).toEqual(['a', 'b'])
    expect(attacher.wake(target.session)).toBeUndefined()
  })

  it('removes them when the last website closes, and loads them again with the next', async () => {
    const { attacher, target, demand } = setup()
    await attacher.wake(target.session)
    demand.opened(1)
    demand.opened(2)
    demand.closed(1)
    await settle()
    expect([...target.held.keys()]).toEqual(['a', 'b'])
    demand.closed(2)
    await settle()
    expect([...target.held.keys()]).toEqual([])
    await attacher.wake(target.session)
    demand.opened(3)
    expect([...target.held.keys()]).toEqual(['a', 'b'])
  })

  it('does not count a page of an extension as a website', async () => {
    const { attacher, target, demand } = setup()
    await attacher.wake(target.session)
    demand.opened(1)
    demand.opened(2, () => false)
    demand.closed(1)
    await settle()
    expect([...target.held.keys()]).toEqual([])
  })
})
