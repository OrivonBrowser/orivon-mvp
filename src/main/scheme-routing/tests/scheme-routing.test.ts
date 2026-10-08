import { describe, expect, it, vi } from 'vitest'
import type { Broker } from '../../../broker/broker-contracts.js'
import type { Manifest } from '../../../contracts/index.js'
import type { AppLinkOption } from '../../sessions/external-links.js'
import { fakeTab } from '../../sessions/tests/fake-tab.js'
import { tabPromptState } from '../../sessions/tab-prompts.js'
import { createAppDirectory, type DirectoryBroker } from '../app-directory.js'
import { OpenUrlQueue } from '../open-url-queue.js'
import { SchemeChoices } from '../scheme-choices.js'
import { createSchemeRouting } from '../scheme-routing.js'

const TORRENT = 'https://torrent.example'
const OTHER = 'https://other.example'
const MAGNET = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567'

function manifestOf (name: string, protocols?: readonly string[]): Manifest {
  return { orivonApiVersion: 0, id: 'x.y', name, version: '1.0.0', entry: 'index.html', capabilities: protocols === undefined ? {} : { protocols } } as Manifest
}

interface FakeApp { origin: string, manifest: Manifest, granted: boolean }

function broker (apps: FakeApp[]): DirectoryBroker {
  const app: Pick<Broker['app'], 'registeredOriginsSync' | 'hasGrantsSync' | 'manifest'> = {
    registeredOriginsSync: () => apps.map((a) => a.origin),
    hasGrantsSync: (origin) => apps.find((a) => a.origin === origin)?.granted === true,
    manifest: async (origin) => {
      const found = apps.find((a) => a.origin === origin)
      if (found === undefined) throw new Error('not registered')
      return found.manifest
    }
  }
  return { app }
}

const TORRENT_APP: FakeApp = { origin: TORRENT, manifest: manifestOf('Torrents', ['magnet', 'bitcoin']), granted: true }

describe('createAppDirectory', () => {
  it('offers an app that declares the scheme and holds a grant', async () => {
    const directory = createAppDirectory(() => broker([TORRENT_APP]))
    expect(await directory.appsFor('magnet')).toEqual([{ origin: TORRENT, name: 'Torrents' }])
  })

  it('never offers an app that did not declare the scheme, or holds no grant', async () => {
    const directory = createAppDirectory(() => broker([
      { origin: OTHER, manifest: manifestOf('Mail', ['mailto']), granted: true },
      { origin: 'https://ungranted.example', manifest: manifestOf('Ungranted', ['magnet']), granted: false },
      { origin: 'https://silent.example', manifest: manifestOf('Silent'), granted: true }
    ]))
    expect(await directory.appsFor('magnet')).toEqual([])
  })

  it('never offers a scheme the browser keeps for itself, even for an app that declares it', async () => {
    const directory = createAppDirectory(() => broker([{ origin: OTHER, manifest: manifestOf('Evil', ['https', 'javascript', 'file', 'orivon']), granted: true }]))
    for (const scheme of ['https', 'javascript', 'file', 'orivon']) expect(await directory.appsFor(scheme), scheme).toEqual([])
  })

  it('offers nothing before the broker exists, and skips an app whose manifest cannot be read', async () => {
    expect(await createAppDirectory(() => undefined).appsFor('magnet')).toEqual([])
    const unreadable = broker([TORRENT_APP])
    unreadable.app.manifest = async () => { throw new Error('gone') }
    expect(await createAppDirectory(() => unreadable).appsFor('magnet')).toEqual([])
  })

  it('lists apps in the order the broker loaded them', async () => {
    const second: FakeApp = { origin: OTHER, manifest: manifestOf('Other', ['magnet']), granted: true }
    expect((await createAppDirectory(() => broker([TORRENT_APP, second])).appsFor('magnet')).map((app) => app.origin)).toEqual([TORRENT, OTHER])
  })
})

function setup (apps: FakeApp[] = [TORRENT_APP]): ReturnType<typeof build> {
  return build(apps)
}

function build (apps: FakeApp[]) {
  const choices = new SchemeChoices(null)
  const queue = new OpenUrlQueue()
  const confirmDefault = vi.fn(async (_tab: unknown, _question: { scheme: string, origin: string, replaces?: string | undefined }) => true)
  const showApp = vi.fn()
  const chooseApp = vi.fn(async () => ({ kind: 'cancel' as const }))
  const { routing, host } = createSchemeRouting({ apps: createAppDirectory(() => broker(apps)), choices, queue, chooseApp, confirmDefault, showApp })
  return { routing, host, choices, queue, confirmDefault, showApp, chooseApp }
}

const settle = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 0)) }

describe('routing.open', () => {
  it('queues the link for the app and shows its tab', async () => {
    const { routing, queue, showApp } = setup()
    const tab = fakeTab()
    routing.open(TORRENT, MAGNET, tab)
    await settle()
    expect(queue.pending(TORRENT)).toBe(1)
    expect(showApp).toHaveBeenCalledWith(TORRENT, tab)
  })

  it('delivers nothing to an app that may not take it: undeclared, ungranted, or a malformed link', async () => {
    const { routing, queue, showApp } = setup([{ ...TORRENT_APP, manifest: manifestOf('Torrents', ['bitcoin']) }])
    routing.open(TORRENT, MAGNET, fakeTab())
    routing.open('https://nobody.example', MAGNET, fakeTab())
    await settle()
    const granted = setup()
    granted.routing.open(TORRENT, 'magnet:?xt=urn:btih:nothex', fakeTab())
    granted.routing.open(TORRENT, `magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=${'a'.repeat(5000)}`, fakeTab())
    await settle()
    expect(queue.pending(TORRENT)).toBe(0)
    expect(granted.queue.pending(TORRENT)).toBe(0)
    expect(showApp).not.toHaveBeenCalled()
    expect(granted.showApp).not.toHaveBeenCalled()
  })
})

describe('routing.defaultAmong', () => {
  const among: AppLinkOption[] = [{ origin: TORRENT, name: 'Torrents' }]

  it('names the chosen app while it is still among those that may take the scheme', () => {
    const { routing, choices } = setup()
    expect(routing.defaultAmong('magnet', among)).toBeUndefined()
    routing.remember('magnet', TORRENT)
    expect(choices.get('magnet')).toBe(TORRENT)
    expect(routing.defaultAmong('magnet', among)).toBe(TORRENT)
    expect(routing.defaultAmong('magnet', [{ origin: OTHER, name: 'Other' }])).toBeUndefined()
  })
})

describe('host.requestHandler', () => {
  it('asks the person in the asking tab and records the answer', async () => {
    const { host, choices, confirmDefault } = setup()
    const tab = fakeTab()
    expect(await host.requestHandler(TORRENT, 'magnet', { contents: () => tab })).toBe(true)
    expect(confirmDefault).toHaveBeenCalledWith(tab, { scheme: 'magnet', origin: TORRENT, replaces: undefined })
    expect(choices.get('magnet')).toBe(TORRENT)
    expect(tabPromptState(tab).prompting).toBe(false)
  })

  it('names the app it would replace', async () => {
    const { host, choices, confirmDefault } = setup([TORRENT_APP, { origin: OTHER, manifest: manifestOf('Other', ['magnet']), granted: true }])
    choices.set('magnet', OTHER)
    await host.requestHandler(TORRENT, 'magnet', { contents: () => fakeTab() })
    expect(confirmDefault.mock.calls[0]?.[1]).toEqual({ scheme: 'magnet', origin: TORRENT, replaces: OTHER })
  })

  it('records nothing when the person declines', async () => {
    const { host, choices, confirmDefault } = setup()
    confirmDefault.mockResolvedValue(false)
    expect(await host.requestHandler(TORRENT, 'magnet', { contents: () => fakeTab() })).toBe(false)
    expect(choices.get('magnet')).toBeUndefined()
  })

  it('does not ask again for an app that is already the default', async () => {
    const { host, choices, confirmDefault } = setup()
    choices.set('magnet', TORRENT)
    expect(await host.requestHandler(TORRENT, 'magnet', { contents: () => fakeTab() })).toBe(true)
    expect(confirmDefault).not.toHaveBeenCalled()
  })

  it('refuses without asking for a scheme the app did not declare or the browser keeps', async () => {
    const { host, confirmDefault } = setup([{ ...TORRENT_APP, manifest: manifestOf('Torrents', ['magnet', 'https']) }])
    for (const scheme of ['mailto', 'https', 'orivon', 'Magnet']) expect(await host.requestHandler(TORRENT, scheme, { contents: () => fakeTab() }), scheme).toBe(false)
    expect(await host.requestHandler('https://nobody.example', 'magnet', { contents: () => fakeTab() })).toBe(false)
    expect(confirmDefault).not.toHaveBeenCalled()
  })

  it('refuses without asking when the asking tab is gone, and asks one question at a time per tab', async () => {
    const { host, confirmDefault } = setup()
    expect(await host.requestHandler(TORRENT, 'magnet', {})).toBe(false)
    const gone = Object.assign(fakeTab(), { isDestroyed: () => true })
    expect(await host.requestHandler(TORRENT, 'magnet', { contents: () => gone })).toBe(false)
    const busy = fakeTab()
    tabPromptState(busy).prompting = true
    expect(await host.requestHandler(TORRENT, 'magnet', { contents: () => busy })).toBe(false)
    expect(confirmDefault).not.toHaveBeenCalled()
  })

  it('treats a failing question as a refusal and frees the tab', async () => {
    const { host, confirmDefault } = setup()
    confirmDefault.mockRejectedValue(new Error('window gone'))
    const tab = fakeTab()
    expect(await host.requestHandler(TORRENT, 'magnet', { contents: () => tab })).toBe(false)
    expect(tabPromptState(tab).prompting).toBe(false)
  })
})

describe('host.isHandler', () => {
  it('is true only for the chosen app while it may still take the scheme', async () => {
    const { host, choices } = setup()
    expect(await host.isHandler(TORRENT, 'magnet')).toBe(false)
    choices.set('magnet', TORRENT)
    expect(await host.isHandler(TORRENT, 'magnet')).toBe(true)
    expect(await host.isHandler(OTHER, 'magnet')).toBe(false)
    const revoked = setup([{ ...TORRENT_APP, granted: false }])
    revoked.choices.set('magnet', TORRENT)
    expect(await revoked.host.isHandler(TORRENT, 'magnet')).toBe(false)
  })
})

describe('host.nextUrl', () => {
  it('gives the page the links routed to its app, one at a time', async () => {
    const { host, routing } = setup()
    routing.open(TORRENT, MAGNET, fakeTab())
    await settle()
    const signal = new AbortController().signal
    expect(await host.nextUrl(TORRENT, signal, undefined)).toBe(MAGNET)
    expect(await host.nextUrl(OTHER, AbortSignal.abort(), undefined)).toBeNull()
  })
})

describe('host.nextUrl and the page that waits', () => {
  it('stops waiting, answering null, when the page navigates away, so a link is never handed to a document that is gone', async () => {
    const { host, routing } = setup()
    const page = Object.assign(new (await import('node:events')).EventEmitter(), {})
    const waiting = host.nextUrl(TORRENT, new AbortController().signal, page)
    page.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(await waiting).toBeNull()
    routing.open(TORRENT, MAGNET, fakeTab())
    await settle()
    expect(await host.nextUrl(TORRENT, new AbortController().signal, page)).toBe(MAGNET)
    expect(page.listenerCount('did-start-navigation')).toBe(0)
  })

  it('keeps waiting through a navigation inside the document or in a subframe, and ends when the tab is destroyed', async () => {
    const { host } = setup()
    const page = new (await import('node:events')).EventEmitter()
    const waiting = host.nextUrl(TORRENT, new AbortController().signal, page)
    page.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    page.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    let settled = false
    void waiting.then(() => { settled = true })
    await settle()
    expect(settled).toBe(false)
    page.emit('destroyed')
    expect(await waiting).toBeNull()
  })
})
