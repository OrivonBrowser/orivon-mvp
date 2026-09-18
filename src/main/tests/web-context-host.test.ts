import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Broker } from '../../broker/broker-contracts.js'

// web-context-host.ts imports `session`/`WebContentsView` from 'electron' at
// module scope, so even a pure-logic test cannot import it without mocking
// first -- same reasoning tab-view.test.ts states for itself. Unlike that
// file's bare `vi.fn()` stand-in, this host genuinely DRIVES the session and
// view (protocol.handle, permission handlers, loadURL, executeJavaScript),
// so the fakes below simulate enough real Electron behaviour -- sessions
// keyed and REUSED by partition string, exactly like the real
// `session.fromPartition` -- for this file's own logic (slot allocation,
// idempotent reconfiguration on reuse, the origin check, post-load
// navigation guards) to be meaningfully exercised.

interface FakeSession {
  readonly partition: string
  readonly protocol: {
    handle: ReturnType<typeof vi.fn>
    unhandle: ReturnType<typeof vi.fn>
    isProtocolHandled: ReturnType<typeof vi.fn>
    handled: Set<string>
    handlers: Map<string, (request: Request) => Promise<Response>>
  }
  readonly webRequest: { onBeforeRequest: ReturnType<typeof vi.fn> }
  setPermissionCheckHandler: ReturnType<typeof vi.fn>
  setPermissionRequestHandler: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  removeAllListeners: ReturnType<typeof vi.fn>
  closeAllConnections: ReturnType<typeof vi.fn>
  clearData: ReturnType<typeof vi.fn>
  downloadListenerCount: number
}

function fakeSession (partition: string): FakeSession {
  const handled = new Set<string>()
  const handlers = new Map<string, (request: Request) => Promise<Response>>()
  const s: FakeSession = {
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
    webRequest: { onBeforeRequest: vi.fn() },
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    on: vi.fn((event: string) => { if (event === 'will-download') s.downloadListenerCount += 1 }),
    removeAllListeners: vi.fn((event: string) => { if (event === 'will-download') s.downloadListenerCount = 0 }),
    closeAllConnections: vi.fn(async () => {}),
    clearData: vi.fn(async () => {}),
    downloadListenerCount: 0
  }
  return s
}

interface FakeWebContents {
  loadURL: ReturnType<typeof vi.fn>
  executeJavaScript: ReturnType<typeof vi.fn>
  setAudioMuted: ReturnType<typeof vi.fn>
  setWindowOpenHandler: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  isDestroyed: ReturnType<typeof vi.fn>
  listeners: Record<string, Array<(...args: unknown[]) => void>>
  destroyed: boolean
  loadedOrigin: string
}

function fakeWebContents (resolvedOrigin: string): FakeWebContents {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {}
  const wc: FakeWebContents = {
    loadedOrigin: resolvedOrigin,
    destroyed: false,
    listeners,
    loadURL: vi.fn(async () => {}),
    executeJavaScript: vi.fn(async (script: string) => {
      if (script === 'self.origin') return wc.loadedOrigin
      return undefined
    }),
    setAudioMuted: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners[event] = [...(listeners[event] ?? []), listener]
    }),
    close: vi.fn(() => { wc.destroyed = true }),
    isDestroyed: vi.fn(() => wc.destroyed)
  }
  return wc
}

const { sessionsByPartition, fromPartitionCalls, lastWebContents } = vi.hoisted(() => ({
  sessionsByPartition: new Map<string, unknown>(),
  fromPartitionCalls: [] as string[],
  lastWebContents: { current: undefined as unknown }
}))

vi.mock('electron', () => ({
  session: {
    fromPartition: vi.fn((partition: string) => {
      fromPartitionCalls.push(partition)
      let s = sessionsByPartition.get(partition)
      if (s === undefined) {
        s = fakeSessionFactory(partition)
        sessionsByPartition.set(partition, s)
      }
      return s
    })
  },
  WebContentsView: class {
    webContents: unknown
    constructor () {
      this.webContents = lastWebContents.current
    }
    setBounds = vi.fn()
  }
}))

// Referenced from inside vi.mock's factory, which vitest hoists above this
// file's own top-level imports -- so this helper must be a `function`
// declaration (hoisted itself) rather than a `const` arrow, and must not
// close over anything besides the vi.hoisted state above.
function fakeSessionFactory (partition: string): FakeSession {
  return fakeSession(partition)
}

vi.mock('../../loader/electron-serve.js', () => ({
  reachOnlyHandlerFor: vi.fn(() => async (_request: Request) => new Response('reach-ok'))
}))

const { createWebContextHost } = await import('../web-context-host.js')

const OPENER = 'https://opener.example'
const ORIGIN = 'https://example.com'

function stubBroker (): Broker {
  return {} as unknown as Broker
}

function setNextWebContents (origin: string): FakeWebContents {
  const wc = fakeWebContents(origin)
  lastWebContents.current = wc
  return wc
}

beforeEach(() => {
  sessionsByPartition.clear()
  fromPartitionCalls.length = 0
  lastWebContents.current = undefined
})

describe('createWebContextHost -- open', () => {
  it('opens a context whose document settles at the requested origin, and returns a fresh host id', async () => {
    setNextWebContents(ORIGIN)
    const host = createWebContextHost(stubBroker)

    const id = await host.open(OPENER, ORIGIN, { width: 1920, height: 1080 })

    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
  })

  it('loads the empty document with baseURLForDataURL set to the requested origin', async () => {
    const wc = setNextWebContents(ORIGIN)
    const host = createWebContextHost(stubBroker)

    await host.open(OPENER, ORIGIN, { width: 100, height: 100 })

    expect(wc.loadURL).toHaveBeenCalledTimes(1)
    const [url, options] = wc.loadURL.mock.calls[0] as [string, { baseURLForDataURL: string }]
    expect(url).toContain('data:text/html,')
    expect(options.baseURLForDataURL).toBe(`${ORIGIN}/`)
  })

  it('mutes audio and denies window.open, on every context', async () => {
    const wc = setNextWebContents(ORIGIN)
    const host = createWebContextHost(stubBroker)

    await host.open(OPENER, ORIGIN, { width: 100, height: 100 })

    expect(wc.setAudioMuted).toHaveBeenCalledWith(true)
    expect(wc.setWindowOpenHandler).toHaveBeenCalledTimes(1)
    const handler = wc.setWindowOpenHandler.mock.calls[0]?.[0] as () => { action: string }
    expect(handler()).toEqual({ action: 'deny' })
  })

  it('rejects and closes the view when the document does not settle at the requested origin', async () => {
    const wc = setNextWebContents('https://wrong.example')
    const host = createWebContextHost(stubBroker)

    await expect(host.open(OPENER, ORIGIN, { width: 100, height: 100 })).rejects.toThrow(/wrong.example/)
    expect(wc.close).toHaveBeenCalledTimes(1)
  })

  it('prevents top-frame navigation, redirect and frame-navigate ONLY after the first load resolves', async () => {
    const wc = setNextWebContents(ORIGIN)
    const host = createWebContextHost(stubBroker)

    await host.open(OPENER, ORIGIN, { width: 100, height: 100 })

    const events = Object.keys(wc.listeners)
    expect(events).toEqual(expect.arrayContaining(['will-navigate', 'will-redirect', 'will-frame-navigate']))

    const navigateEvent = { preventDefault: vi.fn() }
    wc.listeners['will-navigate']?.[0]?.(navigateEvent)
    expect(navigateEvent.preventDefault).toHaveBeenCalledTimes(1)

    const redirectEvent = { preventDefault: vi.fn() }
    wc.listeners['will-redirect']?.[0]?.(redirectEvent)
    expect(redirectEvent.preventDefault).toHaveBeenCalledTimes(1)

    const mainFrameEvent = { preventDefault: vi.fn(), isMainFrame: true }
    wc.listeners['will-frame-navigate']?.[0]?.(mainFrameEvent)
    expect(mainFrameEvent.preventDefault).toHaveBeenCalledTimes(1)

    const subFrameEvent = { preventDefault: vi.fn(), isMainFrame: false }
    wc.listeners['will-frame-navigate']?.[0]?.(subFrameEvent)
    expect(subFrameEvent.preventDefault).not.toHaveBeenCalled()
  })

  it('denies every permission outright and cancels downloads', async () => {
    setNextWebContents(ORIGIN)
    const host = createWebContextHost(stubBroker)

    await host.open(OPENER, ORIGIN, { width: 100, height: 100 })

    const contextSession = sessionsByPartition.get(fromPartitionCalls[0] as string) as FakeSession
    const checkHandler = contextSession.setPermissionCheckHandler.mock.calls[0]?.[0] as () => boolean
    expect(checkHandler()).toBe(false)

    const requestHandler = contextSession.setPermissionRequestHandler.mock.calls[0]?.[0] as
      (wc: unknown, permission: unknown, callback: (granted: boolean) => void) => void
    const callback = vi.fn()
    requestHandler(undefined, 'geolocation', callback)
    expect(callback).toHaveBeenCalledWith(false)

    expect(contextSession.downloadListenerCount).toBe(1)
    const downloadEvent = { preventDefault: vi.fn() }
    const downloadListener = contextSession.on.mock.calls.find((call) => call[0] === 'will-download')?.[1] as
      (event: { preventDefault: () => void }) => void
    downloadListener(downloadEvent)
    expect(downloadEvent.preventDefault).toHaveBeenCalledTimes(1)
  })

  it('cancels a ws:/wss: request via webRequest.onBeforeRequest, and lets an ordinary one through', async () => {
    setNextWebContents(ORIGIN)
    const host = createWebContextHost(stubBroker)

    await host.open(OPENER, ORIGIN, { width: 100, height: 100 })

    const contextSession = sessionsByPartition.get(fromPartitionCalls[0] as string) as FakeSession
    const listener = contextSession.webRequest.onBeforeRequest.mock.calls[0]?.[0] as
      (details: { url: string, resourceType: string }, callback: (response: { cancel?: boolean }) => void) => void

    const wsCallback = vi.fn()
    listener({ url: 'wss://example.com/socket', resourceType: 'webSocket' }, wsCallback)
    expect(wsCallback).toHaveBeenCalledWith({ cancel: true })

    const httpsCallback = vi.fn()
    listener({ url: 'https://example.com/x', resourceType: 'xhr' }, httpsCallback)
    expect(httpsCallback).toHaveBeenCalledWith({})
  })

  it('registers https (CORS-wrapped, reach-only) and http (a flat refusal) on the context session', async () => {
    setNextWebContents(ORIGIN)
    const host = createWebContextHost(stubBroker)

    await host.open(OPENER, ORIGIN, { width: 100, height: 100 })

    const contextSession = sessionsByPartition.get(fromPartitionCalls[0] as string) as FakeSession
    expect(contextSession.protocol.handled).toEqual(new Set(['https', 'http']))

    const httpsHandler = contextSession.protocol.handlers.get('https')
    if (httpsHandler === undefined) throw new Error('https handler not registered')
    const response = await httpsHandler(new Request('https://example.com/'))
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    expect(await response.text()).toBe('reach-ok')

    const preflight = await httpsHandler(new Request('https://example.com/', {
      method: 'OPTIONS',
      headers: { 'access-control-request-method': 'GET' }
    }))
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe(ORIGIN)

    const httpHandler = contextSession.protocol.handlers.get('http')
    if (httpHandler === undefined) throw new Error('http handler not registered')
    const httpResponse = await httpHandler(new Request('http://example.com/'))
    expect(httpResponse.status).toBe(404)
  })

  it('allocates a distinct slot -- and so a distinct partition -- for a second concurrent context of the same opener', async () => {
    setNextWebContents(ORIGIN)
    const host = createWebContextHost(stubBroker)
    await host.open(OPENER, ORIGIN, { width: 100, height: 100 })

    setNextWebContents(ORIGIN)
    await host.open(OPENER, ORIGIN, { width: 100, height: 100 })

    expect(fromPartitionCalls).toHaveLength(2)
    expect(fromPartitionCalls[0]).not.toBe(fromPartitionCalls[1])
    expect(fromPartitionCalls.every((p) => !p.startsWith('persist:'))).toBe(true)
  })

  it('never reuses a partition across two different openers', async () => {
    setNextWebContents(ORIGIN)
    const host = createWebContextHost(stubBroker)
    await host.open(OPENER, ORIGIN, { width: 100, height: 100 })

    setNextWebContents(ORIGIN)
    await host.open('https://other-opener.example', ORIGIN, { width: 100, height: 100 })

    expect(new Set(fromPartitionCalls).size).toBe(2)
  })
})

describe('createWebContextHost -- evaluate', () => {
  it('runs the script through the real webContents.executeJavaScript and returns its result', async () => {
    const wc = setNextWebContents(ORIGIN)
    wc.executeJavaScript.mockImplementation(async (script: string) => script === 'self.origin' ? ORIGIN : 42)
    const host = createWebContextHost(stubBroker)
    const id = await host.open(OPENER, ORIGIN, { width: 100, height: 100 })

    const result = await host.evaluate(id, '21 * 2')

    expect(result).toBe(42)
    expect(wc.executeJavaScript).toHaveBeenLastCalledWith('21 * 2')
  })

  it('throws for an id this host never opened', async () => {
    const host = createWebContextHost(stubBroker)
    await expect(host.evaluate('never-opened', '1')).rejects.toThrow()
  })
})

describe('createWebContextHost -- close', () => {
  it('closes the webContents and clears the session, in that order', async () => {
    const wc = setNextWebContents(ORIGIN)
    const host = createWebContextHost(stubBroker)
    const id = await host.open(OPENER, ORIGIN, { width: 100, height: 100 })
    const contextSession = sessionsByPartition.get(fromPartitionCalls[0] as string) as FakeSession

    await host.close(id)

    expect(wc.close).toHaveBeenCalledTimes(1)
    expect(contextSession.closeAllConnections).toHaveBeenCalledTimes(1)
    expect(contextSession.clearData).toHaveBeenCalledTimes(1)
  })

  it('is idempotent -- closing an already-closed id is a silent no-op', async () => {
    const wc = setNextWebContents(ORIGIN)
    const host = createWebContextHost(stubBroker)
    const id = await host.open(OPENER, ORIGIN, { width: 100, height: 100 })

    await host.close(id)
    await expect(host.close(id)).resolves.toBeUndefined()
    expect(wc.close).toHaveBeenCalledTimes(1) // not called again
  })

  it('is a silent no-op for an id this host never opened', async () => {
    const host = createWebContextHost(stubBroker)
    await expect(host.close('never-opened')).resolves.toBeUndefined()
  })

  it('frees the slot for reuse, on the SAME (reused) partition -- Electron never frees a session', async () => {
    setNextWebContents(ORIGIN)
    const host = createWebContextHost(stubBroker)
    const first = await host.open(OPENER, ORIGIN, { width: 100, height: 100 })
    const firstPartition = fromPartitionCalls[0]

    await host.close(first)

    setNextWebContents(ORIGIN)
    await host.open(OPENER, ORIGIN, { width: 100, height: 100 })

    expect(fromPartitionCalls).toHaveLength(2)
    expect(fromPartitionCalls[1]).toBe(firstPartition)
  })

  it('re-registering protocol handlers on a reused session does not throw (unhandle before handle)', async () => {
    setNextWebContents(ORIGIN)
    const host = createWebContextHost(stubBroker)
    const first = await host.open(OPENER, ORIGIN, { width: 100, height: 100 })
    await host.close(first)

    setNextWebContents(ORIGIN)
    await expect(host.open(OPENER, ORIGIN, { width: 100, height: 100 })).resolves.toBeDefined()
  })

  it('does not accumulate a will-download listener across slot reuse', async () => {
    setNextWebContents(ORIGIN)
    const host = createWebContextHost(stubBroker)
    const first = await host.open(OPENER, ORIGIN, { width: 100, height: 100 })
    await host.close(first)

    setNextWebContents(ORIGIN)
    await host.open(OPENER, ORIGIN, { width: 100, height: 100 })

    const contextSession = sessionsByPartition.get(fromPartitionCalls[0] as string) as FakeSession
    expect(contextSession.downloadListenerCount).toBe(1)
  })
})
