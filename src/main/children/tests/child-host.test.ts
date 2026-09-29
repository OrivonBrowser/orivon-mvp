import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Broker } from '../../../broker/broker-contracts.js'

// child-host.ts imports `session`/`WebContentsView` from 'electron' at module
// scope (as web-context-host.test.ts's own header explains for its file), so
// even a pure-logic test needs a fake session that genuinely tracks which
// schemes got `protocol.handle`d, keyed and reused by partition string like
// the real `session.fromPartition`.

interface FakeSession {
  readonly partition: string
  readonly protocol: {
    handle: ReturnType<typeof vi.fn>
    unhandle: ReturnType<typeof vi.fn>
    isProtocolHandled: ReturnType<typeof vi.fn>
    handled: Set<string>
    handlers: Map<string, (request: Request) => Promise<Response>>
  }
  setPermissionCheckHandler: ReturnType<typeof vi.fn>
  setPermissionRequestHandler: ReturnType<typeof vi.fn>
  setProxy: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  removeAllListeners: ReturnType<typeof vi.fn>
  fetch: ReturnType<typeof vi.fn>
  clearData: ReturnType<typeof vi.fn>
}

function fakeSession (partition: string): FakeSession {
  const handled = new Set<string>()
  const handlers = new Map<string, (request: Request) => Promise<Response>>()
  return {
    partition,
    protocol: {
      handled,
      handlers,
      isProtocolHandled: vi.fn((scheme: string) => handled.has(scheme)),
      handle: vi.fn((scheme: string, handler: (request: Request) => Promise<Response>) => {
        if (handled.has(scheme)) throw new Error(`The scheme has been registered: ${scheme}`)
        handled.add(scheme)
        handlers.set(scheme, handler)
      }),
      unhandle: vi.fn((scheme: string) => { handled.delete(scheme) })
    },
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    setProxy: vi.fn(async () => {}),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
    fetch: vi.fn(async () => new Response('app session response')),
    clearData: vi.fn(async () => {})
  }
}

function fakeWebContents (): Record<string, unknown> {
  return {
    setAudioMuted: vi.fn(),
    setWebRTCIPHandlingPolicy: vi.fn(),
    on: vi.fn(),
    loadURL: vi.fn(async () => {}),
    close: vi.fn(),
    isDestroyed: vi.fn(() => false),
    // The host's own preload reports ready immediately -- these tests are
    // about the session/document wiring, not the W2 readiness handshake
    // (child-host.test.ts's own tests for that live alongside it below).
    ipc: { once: vi.fn((_channel: string, cb: () => void) => { queueMicrotask(cb) }) }
  }
}

const { sessionsByPartition, lastWebContents, defaultSessionFetch } = vi.hoisted(() => ({
  sessionsByPartition: new Map<string, unknown>(),
  lastWebContents: { current: undefined as unknown },
  defaultSessionFetch: vi.fn(async () => new Response('app session response'))
}))

vi.mock('electron', () => ({
  session: {
    fromPartition: vi.fn((partition: string) => {
      let s = sessionsByPartition.get(partition)
      if (s === undefined) {
        s = fakeSessionFactory(partition)
        sessionsByPartition.set(partition, s)
      }
      return s
    }),
    defaultSession: { fetch: defaultSessionFetch }
  },
  WebContentsView: class {
    webContents: unknown
    constructor () {
      this.webContents = lastWebContents.current
    }
  }
}))

// Referenced from inside vi.mock's factory (hoisted above this file's own
// top-level imports), so this must be a hoisted `function` declaration, not
// a `const` arrow, and must not close over anything but the vi.hoisted state.
function fakeSessionFactory (partition: string): FakeSession {
  return fakeSession(partition)
}

vi.mock('../../../loader/electron/serve.js', () => ({
  liveCspHeaderFor: vi.fn(async () => 'default-src \'self\'')
}))

vi.mock('../../shell/tab-view.js', () => ({
  // undefined: no grant/cache registered for this origin in these tests, so
  // appSessionFor falls back to the default session, exactly as it does for
  // a defensive read the registry never actually reaches this far for.
  partitionForTarget: vi.fn(() => undefined)
}))

vi.mock('../../shell/lock-navigation.js', () => ({ lockNavigation: vi.fn() }))

const { createChildHostPool } = await import('../child-host.js')

function stubBroker (manifest: { crossOriginIsolated?: boolean } | undefined = undefined): Broker {
  return { app: { manifest: vi.fn(async () => manifest), grants: vi.fn(async () => []) } } as unknown as Broker
}

beforeEach(() => {
  sessionsByPartition.clear()
  lastWebContents.current = fakeWebContents()
})

describe('createChildHostPool', () => {
  it('handles both http and https on the host session, with the same document handler, for an http: origin', async () => {
    const pool = createChildHostPool(() => stubBroker())
    await pool.getOrCreate('http://localhost:5173')

    const hostSession = [...sessionsByPartition.values()][0] as FakeSession
    expect(hostSession.protocol.handled).toEqual(new Set(['https', 'http']))

    const documentUrl = 'http://localhost:5173/.well-known/orivon/child-host'
    const httpHandler = hostSession.protocol.handlers.get('http')
    expect(httpHandler).toBeDefined()
    const response = await httpHandler?.(new Request(documentUrl))
    expect(response?.headers.get('content-type')).toContain('text/html')
    expect(await response?.text()).toContain('<html>')
  })

  it('handles both http and https for an https: origin too, and delegates a non-document request to the app session', async () => {
    const pool = createChildHostPool(() => stubBroker())
    await pool.getOrCreate('https://app.example')

    const hostSession = [...sessionsByPartition.values()][0] as FakeSession
    expect(hostSession.protocol.handled).toEqual(new Set(['https', 'http']))

    const httpsHandler = hostSession.protocol.handlers.get('https')
    const other = await httpsHandler?.(new Request('https://app.example/some/asset.js'))
    expect(await other?.text()).toBe('app session response')
    expect(defaultSessionFetch).toHaveBeenCalledTimes(1)
  })

  it('F2: a live grant change since the host was built closes it and rebuilds fresh for the next child', async () => {
    const grants = vi.fn(async () => [{ capability: 'net.connect', patterns: ['*'] }])
    const broker = { app: { manifest: vi.fn(async () => undefined), grants } } as unknown as Broker
    const pool = createChildHostPool(() => broker)

    const first = fakeWebContents()
    lastWebContents.current = first
    await pool.getOrCreate('https://app.example')
    expect(first.close).not.toHaveBeenCalled()

    grants.mockResolvedValue([{ capability: 'net.connect', patterns: ['*', 'https://widened.example'] }])
    const second = fakeWebContents()
    lastWebContents.current = second
    await pool.getOrCreate('https://app.example')

    expect(first.close).toHaveBeenCalledOnce()
    expect(second.close).not.toHaveBeenCalled()
  })

  it('F2: no grant change reuses the same host, never closing it', async () => {
    const broker = stubBroker()
    const pool = createChildHostPool(() => broker)

    const first = fakeWebContents()
    lastWebContents.current = first
    await pool.getOrCreate('https://app.example')
    lastWebContents.current = fakeWebContents() // would be used only if a NEW build happened
    await pool.getOrCreate('https://app.example')

    expect(first.close).not.toHaveBeenCalled()
  })

  it('N3: closing a host clears its session\'s web storage', async () => {
    const pool = createChildHostPool(() => stubBroker())
    lastWebContents.current = fakeWebContents()
    await pool.getOrCreate('https://app.example')
    const hostSession = [...sessionsByPartition.values()][0] as FakeSession

    await pool.close('https://app.example')

    expect(hostSession.clearData).toHaveBeenCalledOnce()
  })

  it('W2: a build whose preload never reports ready fails, and closes the view', async () => {
    vi.useFakeTimers()
    try {
      const webContents = fakeWebContents()
      webContents.ipc = { once: vi.fn() } // never calls back -- the preload never got there
      lastWebContents.current = webContents
      const pool = createChildHostPool(() => stubBroker())

      const attempt = pool.getOrCreate('https://app.example')
      const assertion = expect(attempt).rejects.toThrow(/never reported ready/)
      await vi.advanceTimersByTimeAsync(10_000)
      await assertion

      expect(webContents.close).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('F5: a build failure closes the view and does not leave a dead entry blocking a later attempt', async () => {
    // Any failure inside build() must behave the same way; loadURL rejecting
    // is the simplest one to drive directly.
    const failing = fakeWebContents()
    failing.loadURL = vi.fn(async () => { throw new Error('load failed') })
    lastWebContents.current = failing
    const pool = createChildHostPool(() => stubBroker())

    await expect(pool.getOrCreate('https://app.example')).rejects.toThrow('load failed')
    expect(failing.close).toHaveBeenCalledOnce()

    // A later attempt is not stuck behind the failed one.
    const recovered = fakeWebContents()
    lastWebContents.current = recovered
    const host = await pool.getOrCreate('https://app.example')
    expect(host.origin).toBe('https://app.example')
    expect(recovered.close).not.toHaveBeenCalled()
  })

  it('F5: postPagePort never throws when the host\'s frame is gone -- logs instead', async () => {
    const pool = createChildHostPool(() => stubBroker())
    const contents = fakeWebContents()
    lastWebContents.current = contents
    const host = await pool.getOrCreate('https://app.example')

    contents.mainFrame = { postMessage: () => { throw new Error('frame is gone') } }

    expect(() => { host.postPagePort({} as never) }).not.toThrow()
  })
})
