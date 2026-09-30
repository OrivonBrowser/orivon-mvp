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
const { EMBED_EVENT_CHANNEL } = await import('../../channels.js')
const { embedPartitionFor } = await import('../embed-guard.js')

/** An embedder WebContents: a real EventEmitter (embed-host.ts attaches `will-attach-webview`/`did-attach-webview` to it) with a mutable top-frame URL and a frame that records what is sent to it. */
function fakeEmbedder (url: string): EventEmitter & { mainFrame: { url: string, send: ReturnType<typeof vi.fn> }, destroyed: boolean } {
  const embedder = Object.assign(new EventEmitter(), {
    destroyed: false,
    mainFrame: { url, send: vi.fn() },
    getType: () => 'window',
    isDestroyed: () => embedder.destroyed
  })
  return embedder
}

/** `session` is the guest's OWN Session object, the way Electron hands back whatever `webPreferences.partition` the attach actually used -- did-attach-webview reads origin from it, never from the embedder. */
function fakeGuest (id: number, session: FakeSession): { id: number, session: FakeSession, isDestroyed: () => boolean, close: ReturnType<typeof vi.fn>, setWindowOpenHandler: ReturnType<typeof vi.fn>, once: ReturnType<typeof vi.fn> } {
  return { id, session, isDestroyed: () => false, close: vi.fn(), setWindowOpenHandler: vi.fn(), once: vi.fn() }
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

describe('installEmbedHost -- a guest is paired with the app origin its OWN session belongs to', () => {
  // fakeApp is one EventEmitter shared by the whole file (vi.mock runs
  // once); each test's own installEmbedHost() call must not leave its
  // 'web-contents-created' listener wired for the NEXT test's embedder.
  beforeEach(() => {
    fakeApp.removeAllListeners()
    sessionsByPartition.clear()
  })

  it('attaches the guest under the origin that configured its session, even if the embedder navigates before did-attach-webview fires', () => {
    const attach = vi.fn((_origin: string, _destroy: () => void) => ({ release: vi.fn() }))
    const broker = fakeBroker(new Set([ORIGIN_A, ORIGIN_B]), attach)
    const host = installEmbedHost(broker, '/preload/embed.js')
    const embedder = fakeEmbedder(`${ORIGIN_A}/tab`)

    fakeApp.emit('web-contents-created', {}, embedder)
    embedder.emit('will-attach-webview', { preventDefault: vi.fn() }, {}, {})
    const sessionA = sessionsByPartition.get(embedPartitionFor(ORIGIN_A))
    if (sessionA === undefined) throw new Error('no session was configured for origin A')

    // The embedder's own top frame navigates to a DIFFERENT origin's grant
    // before the guest finishes attaching. The guest itself was already
    // created under the partition will-attach-webview set, carried on its
    // own session -- re-reading the embedder's URL here would get this
    // wrong.
    embedder.mainFrame.url = `${ORIGIN_B}/elsewhere`

    const guest = fakeGuest(42, sessionA)
    embedder.emit('did-attach-webview', {}, guest)

    expect(attach).toHaveBeenCalledTimes(1)
    expect(attach.mock.calls[0]?.[0]).toBe(ORIGIN_A)
    expect(host.ownerOf(42)).toBe(ORIGIN_A)
  })

  it('closes the guest and attaches nothing when its session was never configured by partitionReady', () => {
    const attach = vi.fn((_origin: string, _destroy: () => void) => ({ release: vi.fn() }))
    const broker = fakeBroker(new Set([ORIGIN_A]), attach)
    const host = installEmbedHost(broker, '/preload/embed.js')
    const embedder = fakeEmbedder(`${ORIGIN_A}/tab`)

    fakeApp.emit('web-contents-created', {}, embedder)
    // No will-attach-webview ran, so no session was ever recorded against an origin.
    const guest = fakeGuest(7, fakeSession())
    embedder.emit('did-attach-webview', {}, guest)

    expect(attach).not.toHaveBeenCalled()
    expect(guest.close).toHaveBeenCalledTimes(1)
    expect(host.ownerOf(7)).toBeUndefined()
  })

  it('pairs two guests attached to the same origin correctly however their did-attach-webview events are ordered', () => {
    const attach = vi.fn((_origin: string, _destroy: () => void) => ({ release: vi.fn() }))
    const broker = fakeBroker(new Set([ORIGIN_A]), attach)
    const host = installEmbedHost(broker, '/preload/embed.js')
    const embedder = fakeEmbedder(`${ORIGIN_A}/tab`)

    fakeApp.emit('web-contents-created', {}, embedder)
    // Two <webview> elements both start attaching while the embedder is at
    // origin A; partitionReady configures the partition once, so both share
    // the same session.
    embedder.emit('will-attach-webview', { preventDefault: vi.fn() }, {}, {})
    embedder.emit('will-attach-webview', { preventDefault: vi.fn() }, {}, {})
    const sessionA = sessionsByPartition.get(embedPartitionFor(ORIGIN_A))
    if (sessionA === undefined) throw new Error('no session was configured for origin A')

    const guestOne = fakeGuest(1, sessionA)
    const guestTwo = fakeGuest(2, sessionA)
    // did-attach-webview fires for the SECOND webview first: each guest is
    // paired by its own session, not by arrival order, so this still
    // resolves correctly.
    embedder.emit('did-attach-webview', {}, guestTwo)
    embedder.emit('did-attach-webview', {}, guestOne)

    expect(attach.mock.calls.map((call) => call[0])).toEqual([ORIGIN_A, ORIGIN_A])
    expect(host.ownerOf(1)).toBe(ORIGIN_A)
    expect(host.ownerOf(2)).toBe(ORIGIN_A)
  })

  it('attributes each guest to the origin that actually configured its own session, when the embedder admits a second origin before the first guest attaches', () => {
    const attach = vi.fn((_origin: string, _destroy: () => void) => ({ release: vi.fn() }))
    const broker = fakeBroker(new Set([ORIGIN_A, ORIGIN_B]), attach)
    const host = installEmbedHost(broker, '/preload/embed.js')
    const embedder = fakeEmbedder(`${ORIGIN_A}/tab`)

    fakeApp.emit('web-contents-created', {}, embedder)
    // A <webview> starts attaching at origin A; before its did-attach-webview
    // fires, the embedder navigates and admits a second <webview> at origin B.
    embedder.emit('will-attach-webview', { preventDefault: vi.fn() }, {}, {})
    const sessionA = sessionsByPartition.get(embedPartitionFor(ORIGIN_A))
    embedder.mainFrame.url = `${ORIGIN_B}/elsewhere`
    embedder.emit('will-attach-webview', { preventDefault: vi.fn() }, {}, {})
    const sessionB = sessionsByPartition.get(embedPartitionFor(ORIGIN_B))
    if (sessionA === undefined || sessionB === undefined) throw new Error('a session was not configured')

    const guestA = fakeGuest(9, sessionA)
    const guestB = fakeGuest(10, sessionB)
    // Both attaches complete, each still attributed to the origin that
    // configured its own session, even though the embedder admitted a
    // second origin's <webview> before the first one's did-attach-webview
    // fired.
    embedder.emit('did-attach-webview', {}, guestB)
    embedder.emit('did-attach-webview', {}, guestA)

    expect(attach.mock.calls.map((call) => call[0]).sort()).toEqual([ORIGIN_A, ORIGIN_B])
    expect(host.ownerOf(9)).toBe(ORIGIN_A)
    expect(host.ownerOf(10)).toBe(ORIGIN_B)
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

// ADR-0047: what a shown page asks for reaches the app that shows it, and
// nothing else happens. The wiring only -- embed-events.test.ts covers what
// the notices contain.
describe('installEmbedHost -- a shown page\'s popups and downloads are told to its app', () => {
  beforeEach(() => {
    fakeApp.removeAllListeners()
    sessionsByPartition.clear()
  })

  type OpenHandler = (details: { url: string, frameName: string, disposition: string, referrer: { url: string }, postBody?: unknown }) => { action: string }
  interface Downloading { getURLChain: () => string[], getFilename: () => string, getMimeType: () => string, getTotalBytes: () => number }

  function attached (): { embedder: ReturnType<typeof fakeEmbedder>, guest: ReturnType<typeof fakeGuest>, session: FakeSession, handler: () => OpenHandler } {
    const broker = fakeBroker(new Set([ORIGIN_A]), vi.fn(() => ({ release: vi.fn() })))
    installEmbedHost(broker, '/preload/embed.js')
    const embedder = fakeEmbedder(`${ORIGIN_A}/tab`)
    fakeApp.emit('web-contents-created', {}, embedder)
    embedder.emit('will-attach-webview', { preventDefault: vi.fn() }, {}, {})
    const session = sessionsByPartition.get(embedPartitionFor(ORIGIN_A))
    if (session === undefined) throw new Error('no session was configured')
    const guest = fakeGuest(42, session)
    embedder.emit('did-attach-webview', {}, guest)
    return { embedder, guest, session, handler: () => guest.setWindowOpenHandler.mock.calls.at(-1)?.[0] as OpenHandler }
  }

  function willDownload (session: FakeSession): (event: { preventDefault: () => void }, item: Downloading, guest: { id: number }) => void {
    const call = session.on.mock.calls.find(([name]) => name === 'will-download')
    if (call === undefined) throw new Error('no will-download listener')
    return call[1] as ReturnType<typeof willDownload>
  }

  const item = (over: Partial<Downloading> = {}): Downloading =>
    ({ getURLChain: () => ['https://a.example/go', 'https://a.example/f.bin'], getFilename: () => 'f.bin', getMimeType: () => 'application/octet-stream', getTotalBytes: () => 9, ...over })

  it('denies a guest\'s windows from the moment it exists, before it has attached', () => {
    installEmbedHost(fakeBroker(new Set([ORIGIN_A]), vi.fn()), '/preload/embed.js')
    const setWindowOpenHandler = vi.fn()
    fakeApp.emit('web-contents-created', {}, Object.assign(new EventEmitter(), { getType: () => 'webview', setWindowOpenHandler }))
    expect((setWindowOpenHandler.mock.calls[0]?.[0] as () => unknown)()).toEqual({ action: 'deny' })
  })

  it('denies the window and sends the embedder\'s main frame the popup, tagged with the guest\'s id', () => {
    const { embedder, handler } = attached()
    const outcome = handler()({ url: 'https://a.example/x', frameName: 'pane', disposition: 'foreground-tab', referrer: { url: 'https://a.example/' }, postBody: { data: [] } })
    expect(outcome).toEqual({ action: 'deny' })
    expect(embedder.mainFrame.send).toHaveBeenCalledExactlyOnceWith(EMBED_EVENT_CHANNEL, 42, 'orivon-popup', {
      url: 'https://a.example/x', disposition: 'foreground-tab', frameName: 'pane', referrer: 'https://a.example/', method: 'POST'
    })
  })

  it('cancels a download after reading the item, and sends the embedder the download', () => {
    const { embedder, session } = attached()
    const event = { preventDefault: vi.fn() }
    const read = vi.fn(() => 'f.bin')
    willDownload(session)(event, item({ getFilename: read }), { id: 42 })
    expect(read.mock.invocationCallOrder[0]).toBeLessThan(event.preventDefault.mock.invocationCallOrder[0] as number)
    expect(embedder.mainFrame.send).toHaveBeenCalledExactlyOnceWith(EMBED_EVENT_CHANNEL, 42, 'orivon-download', {
      url: 'https://a.example/f.bin', filename: 'f.bin', mimeType: 'application/octet-stream', totalBytes: 9
    })
  })

  it('cancels a download from a page it does not know, and tells nobody', () => {
    const { embedder, session } = attached()
    const event = { preventDefault: vi.fn() }
    willDownload(session)(event, item(), { id: 999 })
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(embedder.mainFrame.send).not.toHaveBeenCalled()
  })

  it('tells nobody once the guest is gone, or the page holding it is', () => {
    const { embedder, guest, handler } = attached()
    const destroyed = guest.once.mock.calls.find(([name]) => name === 'destroyed')?.[1] as () => void
    embedder.destroyed = true
    handler()({ url: 'https://a.example/x', frameName: '', disposition: 'default', referrer: { url: '' } })
    embedder.destroyed = false
    destroyed()
    handler()({ url: 'https://a.example/y', frameName: '', disposition: 'default', referrer: { url: '' } })
    expect(embedder.mainFrame.send).not.toHaveBeenCalled()
  })

  it('still denies the window when the page\'s frame is gone between the check and the send', () => {
    const { embedder, handler } = attached()
    embedder.mainFrame.send.mockImplementation(() => { throw new Error('Render frame was disposed') })
    expect(handler()({ url: 'https://a.example/x', frameName: '', disposition: 'default', referrer: { url: '' } })).toEqual({ action: 'deny' })
  })
})
