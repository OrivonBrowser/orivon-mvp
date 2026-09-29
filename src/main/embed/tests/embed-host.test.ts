import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Broker } from '../../../broker/broker-contracts.js'

// embed-host.ts imports `app`/`session` from 'electron' at module scope,
// so even a pure-logic test cannot import it without mocking first (same
// reasoning permission-gate.test.ts and web-context-host.test.ts state for
// themselves). `fakeApp` is a REAL EventEmitter -- installEmbedHost wires
// its own listener to it via `app.on('web-contents-created', ...)`, and
// this suite needs to actually fire that event the way Electron would.
const fakeApp = Object.assign(new EventEmitter(), {})
fakeApp.setMaxListeners(0)

interface FakeSession {
  on: ReturnType<typeof vi.fn>
  webRequest: { onBeforeRequest: ReturnType<typeof vi.fn>, onBeforeSendHeaders: ReturnType<typeof vi.fn> }
  resolveHost: ReturnType<typeof vi.fn>
}

/** Keyed by partition string, the way the real `session.fromPartition` reuses one Session per partition -- lets a test retrieve the exact fake session `configureEmbedSession` wired. */
const sessionsByPartition = new Map<string, FakeSession>()

function fakeSession (): FakeSession {
  return {
    on: vi.fn(),
    webRequest: { onBeforeRequest: vi.fn(), onBeforeSendHeaders: vi.fn() },
    resolveHost: vi.fn(async () => ({ endpoints: [] }))
  }
}

vi.mock('electron', () => ({
  app: fakeApp,
  session: {
    fromPartition: vi.fn((partition: string) => {
      let s = sessionsByPartition.get(partition)
      if (s === undefined) { s = fakeSession(); sessionsByPartition.set(partition, s) }
      return s
    })
  }
}))

const { installEmbedHost } = await import('../embed-host.js')

/** An embedder WebContents: a real EventEmitter (embed-host.ts attaches `will-attach-webview`/`did-attach-webview` to it) with a mutable top-frame URL. */
function fakeEmbedder (url: string): EventEmitter & { mainFrame: { url: string } } {
  return Object.assign(new EventEmitter(), { mainFrame: { url } })
}

function fakeGuest (id: number): { id: number, isDestroyed: () => boolean, close: ReturnType<typeof vi.fn>, setWindowOpenHandler: ReturnType<typeof vi.fn>, once: ReturnType<typeof vi.fn> } {
  return { id, isDestroyed: () => false, close: vi.fn(), setWindowOpenHandler: vi.fn(), once: vi.fn() }
}

function fakeBroker (origins: ReadonlySet<string>, attach: ReturnType<typeof vi.fn>): Broker {
  return {
    embed: {
      originsSync: (origin: string) => origins.has(origin) ? ['*'] : undefined,
      scriptSync: () => undefined,
      attach,
      setScript: async () => {}
    }
  } as unknown as Broker
}

const ORIGIN_A = 'https://a.example'
const ORIGIN_B = 'https://b.example'

describe('installEmbedHost -- the embedder origin captured at will-attach-webview reaches did-attach-webview', () => {
  // fakeApp is one EventEmitter shared by the whole file (vi.mock runs
  // once); each test's own installEmbedHost() call must not leave its
  // 'web-contents-created' listener wired for the NEXT test's embedder.
  beforeEach(() => {
    fakeApp.removeAllListeners()
    sessionsByPartition.clear()
  })

  it('attaches the guest under the origin admitted at will-attach-webview, even if the embedder navigates before did-attach-webview fires', () => {
    const attach = vi.fn((_origin: string, _destroy: () => void) => ({ release: vi.fn() }))
    const broker = fakeBroker(new Set([ORIGIN_A, ORIGIN_B]), attach)
    const host = installEmbedHost(broker, '/preload/embed.js')
    const embedder = fakeEmbedder(`${ORIGIN_A}/tab`)

    fakeApp.emit('web-contents-created', {}, embedder)
    embedder.emit('will-attach-webview', { preventDefault: vi.fn() }, {}, {})

    // The embedder's own top frame navigates to a DIFFERENT origin's grant
    // before the guest finishes attaching -- exactly the race the finding
    // describes. A re-read at did-attach-webview would see this new URL.
    embedder.mainFrame.url = `${ORIGIN_B}/elsewhere`

    const guest = fakeGuest(42)
    embedder.emit('did-attach-webview', {}, guest)

    expect(attach).toHaveBeenCalledTimes(1)
    expect(attach.mock.calls[0]?.[0]).toBe(ORIGIN_A)
    expect(host.ownerOf(42)).toBe(ORIGIN_A)
  })

  it('closes the guest and attaches nothing when did-attach-webview fires with no matching will-attach-webview', () => {
    const attach = vi.fn((_origin: string, _destroy: () => void) => ({ release: vi.fn() }))
    const broker = fakeBroker(new Set([ORIGIN_A]), attach)
    const host = installEmbedHost(broker, '/preload/embed.js')
    const embedder = fakeEmbedder(`${ORIGIN_A}/tab`)

    fakeApp.emit('web-contents-created', {}, embedder)
    const guest = fakeGuest(7)
    embedder.emit('did-attach-webview', {}, guest)

    expect(attach).not.toHaveBeenCalled()
    expect(guest.close).toHaveBeenCalledTimes(1)
    expect(host.ownerOf(7)).toBeUndefined()
  })

  it('pairs two overlapping attaches on the same embedder in FIFO order', () => {
    const attach = vi.fn((_origin: string, _destroy: () => void) => ({ release: vi.fn() }))
    const broker = fakeBroker(new Set([ORIGIN_A, ORIGIN_B]), attach)
    const host = installEmbedHost(broker, '/preload/embed.js')
    const embedder = fakeEmbedder(`${ORIGIN_A}/tab`)

    fakeApp.emit('web-contents-created', {}, embedder)
    // Two <webview> elements both start attaching while the embedder is at
    // origin A, before either finishes.
    embedder.emit('will-attach-webview', { preventDefault: vi.fn() }, {}, {})
    embedder.emit('will-attach-webview', { preventDefault: vi.fn() }, {}, {})

    const guestOne = fakeGuest(1)
    const guestTwo = fakeGuest(2)
    embedder.emit('did-attach-webview', {}, guestOne)
    embedder.emit('did-attach-webview', {}, guestTwo)

    expect(attach.mock.calls.map((call) => call[0])).toEqual([ORIGIN_A, ORIGIN_A])
    expect(host.ownerOf(1)).toBe(ORIGIN_A)
    expect(host.ownerOf(2)).toBe(ORIGIN_A)
  })

  it('drops an admission whose attach never completed once the embedder admits another origin', () => {
    const attach = vi.fn((_origin: string, _destroy: () => void) => ({ release: vi.fn() }))
    const broker = fakeBroker(new Set([ORIGIN_A, ORIGIN_B]), attach)
    const host = installEmbedHost(broker, '/preload/embed.js')
    const embedder = fakeEmbedder(`${ORIGIN_A}/tab`)

    fakeApp.emit('web-contents-created', {}, embedder)
    // A <webview> starts attaching at origin A and never finishes.
    embedder.emit('will-attach-webview', { preventDefault: vi.fn() }, {}, {})
    embedder.mainFrame.url = `${ORIGIN_B}/elsewhere`
    embedder.emit('will-attach-webview', { preventDefault: vi.fn() }, {}, {})

    const guest = fakeGuest(9)
    embedder.emit('did-attach-webview', {}, guest)

    expect(attach.mock.calls.map((call) => call[0])).toEqual([ORIGIN_B])
    expect(host.ownerOf(9)).toBe(ORIGIN_B)
  })
})

// A286: configureEmbedSession wires the guest session's OWN resolveHost
// into guestRequestAllowed (embed-guard.test.ts covers that function's
// own decisions in isolation) -- this checks the WIRING: that resolveHost
// is the one actually asked, that its `endpoints[].address` shape is read
// correctly, and that onBeforeRequest's callback receives `cancel` built
// from the async verdict rather than a synchronous one.
describe('configureEmbedSession -- onBeforeRequest resolves through the guest session before admitting a "*" document', () => {
  beforeEach(() => {
    fakeApp.removeAllListeners()
    sessionsByPartition.clear()
  })

  function attachAndGetSession (appOrigin: string): FakeSession {
    const attach = vi.fn((_origin: string, _destroy: () => void) => ({ release: vi.fn() }))
    const broker = fakeBroker(new Set([appOrigin]), attach)
    installEmbedHost(broker, '/preload/embed.js')
    const embedder = fakeEmbedder(`${appOrigin}/tab`)
    fakeApp.emit('web-contents-created', {}, embedder)
    embedder.emit('will-attach-webview', { preventDefault: vi.fn() }, {}, {})
    // Exactly one session gets configured for this run.
    const [session] = sessionsByPartition.values()
    if (session === undefined) throw new Error('no session was configured')
    return session
  }

  it('refuses a document whose host resolves (through THIS session) to a private address', async () => {
    const session = attachAndGetSession(ORIGIN_A)
    session.resolveHost.mockImplementation(async () => ({ endpoints: [{ address: '192.168.1.1', family: 'ipv4' }] }))
    const onBeforeRequest = session.webRequest.onBeforeRequest.mock.calls[0]?.[0] as
      (details: { url: string, resourceType: string }, callback: (r: { cancel: boolean }) => void) => void

    const callback = vi.fn()
    onBeforeRequest({ url: 'https://attacker.example/', resourceType: 'mainFrame' }, callback)
    await new Promise((resolve) => { setImmediate(resolve) })

    expect(session.resolveHost).toHaveBeenCalledWith('attacker.example')
    expect(callback).toHaveBeenCalledWith({ cancel: true })
  })

  it('allows a document whose host resolves (through THIS session) to only public addresses', async () => {
    const session = attachAndGetSession(ORIGIN_A)
    session.resolveHost.mockImplementation(async () => ({ endpoints: [{ address: '93.184.216.34', family: 'ipv4' }] }))
    const onBeforeRequest = session.webRequest.onBeforeRequest.mock.calls[0]?.[0] as
      (details: { url: string, resourceType: string }, callback: (r: { cancel: boolean }) => void) => void

    const callback = vi.fn()
    onBeforeRequest({ url: 'https://good.example/', resourceType: 'mainFrame' }, callback)
    await new Promise((resolve) => { setImmediate(resolve) })

    expect(callback).toHaveBeenCalledWith({ cancel: false })
  })

  it('never calls resolveHost for a subresource, or when the grant is gone', async () => {
    const session = attachAndGetSession(ORIGIN_A)
    const onBeforeRequest = session.webRequest.onBeforeRequest.mock.calls[0]?.[0] as
      (details: { url: string, resourceType: string }, callback: (r: { cancel: boolean }) => void) => void

    const subresource = vi.fn()
    onBeforeRequest({ url: 'https://cdn.example/lib.js', resourceType: 'script' }, subresource)
    await new Promise((resolve) => { setImmediate(resolve) })

    expect(session.resolveHost).not.toHaveBeenCalled()
    expect(subresource).toHaveBeenCalledWith({ cancel: false })
  })

  it('cancels rather than leaving the callback uncalled when resolveHost itself rejects', async () => {
    const session = attachAndGetSession(ORIGIN_A)
    session.resolveHost.mockImplementation(async () => { throw new Error('DNS failed') })
    const onBeforeRequest = session.webRequest.onBeforeRequest.mock.calls[0]?.[0] as
      (details: { url: string, resourceType: string }, callback: (r: { cancel: boolean }) => void) => void

    const callback = vi.fn()
    onBeforeRequest({ url: 'https://attacker.example/', resourceType: 'mainFrame' }, callback)
    await new Promise((resolve) => { setImmediate(resolve) })

    expect(callback).toHaveBeenCalledWith({ cancel: true })
  })
})

// A shown page reaches the verifier the same ordinary way a tab does, so
// whatever it puts on its own request for the partition header must be
// stripped and replaced with its OWN top-level page's origin -- never left
// as whatever the page set, and never left unset for a page's own document
// request either.
describe('configureEmbedSession -- the verifier partition header is stripped and restamped', () => {
  beforeEach(() => {
    fakeApp.removeAllListeners()
    sessionsByPartition.clear()
  })

  function attachAndGetSession (appOrigin: string): FakeSession {
    const attach = vi.fn((_origin: string, _destroy: () => void) => ({ release: vi.fn() }))
    const broker = fakeBroker(new Set([appOrigin]), attach)
    installEmbedHost(broker, '/preload/embed.js')
    const embedder = fakeEmbedder(`${appOrigin}/tab`)
    fakeApp.emit('web-contents-created', {}, embedder)
    embedder.emit('will-attach-webview', { preventDefault: vi.fn() }, {}, {})
    const [session] = sessionsByPartition.values()
    if (session === undefined) throw new Error('no session was configured')
    return session
  }

  interface Details { url: string, resourceType: string, requestHeaders: Record<string, string>, frame: { top: { url: string } | null } | undefined }
  type Listener = (details: Details, callback: (r: { requestHeaders: Record<string, string> }) => void) => void

  it("stamps a top-level page's own request with its own origin, never with what it sent", () => {
    const session = attachAndGetSession(ORIGIN_A)
    const onBeforeSendHeaders = session.webRequest.onBeforeSendHeaders.mock.calls[0]?.[1] as Listener
    const callback = vi.fn()
    onBeforeSendHeaders({
      url: 'https://shown.eth/',
      resourceType: 'mainFrame',
      requestHeaders: { 'x-orivon-partition': 'https://attacker.example' },
      frame: { top: { url: 'https://shown.eth/' } }
    }, callback)
    expect(callback).toHaveBeenCalledWith({ requestHeaders: { 'x-orivon-partition': 'https://shown.eth' } })
  })

  it('strips the header from a subframe request with no top frame to ask, rather than keeping what it sent', () => {
    const session = attachAndGetSession(ORIGIN_A)
    const onBeforeSendHeaders = session.webRequest.onBeforeSendHeaders.mock.calls[0]?.[1] as Listener
    const callback = vi.fn()
    onBeforeSendHeaders({
      url: 'https://shown.eth/frame',
      resourceType: 'subFrame',
      requestHeaders: { 'x-orivon-partition': 'https://attacker.example' },
      frame: undefined
    }, callback)
    expect(callback).toHaveBeenCalledWith({ requestHeaders: {} })
  })

  it('is scoped to the verifier-routed hosts, the same way the default session is', () => {
    const session = attachAndGetSession(ORIGIN_A)
    const [filter] = session.webRequest.onBeforeSendHeaders.mock.calls[0] as [{ urls: string[] }]
    expect(filter.urls).toEqual(expect.arrayContaining(['https://*.eth/*']))
  })
})
