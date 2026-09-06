import { describe, expect, it, vi } from 'vitest'
import { createSocketBridge } from './socket-bridge.js'
import type { IpcRendererLike } from './socket-bridge.js'
import type { PortLike } from './socket-port.js'

const HANDLE = 'handle-1'

/** A fake ipcRenderer -- captures the PORT_CHANNEL listener so a test can simulate a delivery. */
function fakeIpcRenderer (): IpcRendererLike & { emit: (payload: unknown, ports?: readonly unknown[]) => void } {
  let listener: ((event: { readonly ports?: readonly unknown[] }, payload: unknown) => void) | undefined
  return {
    on: (_channel, l) => { listener = l },
    emit: (payload, ports = ['raw-port']) => { listener?.({ ports }, payload) }
  }
}

interface FakeWrappedPort extends PortLike { readonly raw: unknown, closed: boolean }

function fakeWrapPort (): { wrapPort: (raw: unknown) => FakeWrappedPort, wrapped: FakeWrappedPort[] } {
  const wrapped: FakeWrappedPort[] = []
  return {
    wrapPort: (raw) => {
      const port: FakeWrappedPort = {
        raw, closed: false, postMessage: () => {}, onMessage: () => {}, close: () => { port.closed = true }
      }
      wrapped.push(port)
      return port
    },
    wrapped
  }
}

describe('createSocketBridge -- port arrives AFTER waitForPort is called', () => {
  it('resolves the waiter with the wrapped port once it arrives', async () => {
    const ipcRenderer = fakeIpcRenderer()
    const { wrapPort } = fakeWrapPort()
    const bridge = createSocketBridge({ ipcRenderer, portChannel: 'orivon:port', wrapPort })

    const waiting = bridge.waitForPort(HANDLE)
    ipcRenderer.emit({ handleId: HANDLE })

    const port = await waiting
    expect(port).toMatchObject({ raw: 'raw-port' })
  })

  it('a delivery for a different handleId does not resolve an unrelated waiter', async () => {
    const ipcRenderer = fakeIpcRenderer()
    const { wrapPort } = fakeWrapPort()
    const bridge = createSocketBridge({ ipcRenderer, portChannel: 'orivon:port', wrapPort, waitTimeoutMs: 50 })

    const waiting = bridge.waitForPort(HANDLE)
    ipcRenderer.emit({ handleId: 'some-other-handle' })

    await expect(waiting).rejects.toThrow()
  })
})

describe('createSocketBridge -- port arrives BEFORE waitForPort is called', () => {
  it('waitForPort resolves immediately with the already-arrived port', async () => {
    const ipcRenderer = fakeIpcRenderer()
    const { wrapPort } = fakeWrapPort()
    const bridge = createSocketBridge({ ipcRenderer, portChannel: 'orivon:port', wrapPort })

    ipcRenderer.emit({ handleId: HANDLE })
    const port = await bridge.waitForPort(HANDLE)

    expect(port).toMatchObject({ raw: 'raw-port' })
  })

  it('an early port nobody ever claims is closed once its own timeout elapses', async () => {
    vi.useFakeTimers()
    try {
      const ipcRenderer = fakeIpcRenderer()
      const { wrapPort, wrapped } = fakeWrapPort()
      createSocketBridge({ ipcRenderer, portChannel: 'orivon:port', wrapPort, waitTimeoutMs: 100 })

      ipcRenderer.emit({ handleId: HANDLE }) // never claimed by waitForPort
      await vi.advanceTimersByTimeAsync(101)

      expect(wrapped).toHaveLength(1)
      expect(wrapped[0]?.closed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('createSocketBridge -- a waiter that is never delivered', () => {
  it('rejects after waitTimeoutMs rather than hanging forever', async () => {
    vi.useFakeTimers()
    try {
      const ipcRenderer = fakeIpcRenderer()
      const { wrapPort } = fakeWrapPort()
      const bridge = createSocketBridge({ ipcRenderer, portChannel: 'orivon:port', wrapPort, waitTimeoutMs: 100 })

      const waiting = bridge.waitForPort(HANDLE)
      const assertion = expect(waiting).rejects.toMatchObject({ name: 'OrivonError', code: 'timeout' })
      await vi.advanceTimersByTimeAsync(101)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('P-F5: the timeout rejection is a plain OrivonError-shaped object, not a raw Error, and never leaks the handle id', async () => {
    vi.useFakeTimers()
    try {
      const ipcRenderer = fakeIpcRenderer()
      const { wrapPort } = fakeWrapPort()
      const bridge = createSocketBridge({ ipcRenderer, portChannel: 'orivon:port', wrapPort, waitTimeoutMs: 100 })

      const waiting = bridge.waitForPort(HANDLE)
      waiting.catch(() => {})
      await vi.advanceTimersByTimeAsync(101)

      let reason: unknown
      try { await waiting } catch (error) { reason = error }

      expect(reason).not.toBeInstanceOf(Error)
      expect(reason).toMatchObject({ name: 'OrivonError', code: 'timeout' })
      expect(JSON.stringify(reason)).not.toContain(HANDLE)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('createSocketBridge -- P-F12: a collision on handleId is refused, not silently clobbered', () => {
  it('a second waitForPort for the same handleId, while the first is still pending, rejects immediately with internal', async () => {
    const ipcRenderer = fakeIpcRenderer()
    const { wrapPort } = fakeWrapPort()
    const bridge = createSocketBridge({ ipcRenderer, portChannel: 'orivon:port', wrapPort, waitTimeoutMs: 10_000 })

    const first = bridge.waitForPort(HANDLE)
    const second = bridge.waitForPort(HANDLE)

    await expect(second).rejects.toMatchObject({ code: 'internal' })

    ipcRenderer.emit({ handleId: HANDLE })
    const port = await first
    expect(port).toMatchObject({ raw: 'raw-port' })
  })

  it('clears the first waiter\'s timer once its port is delivered -- no dangling timer survives', async () => {
    vi.useFakeTimers()
    try {
      const ipcRenderer = fakeIpcRenderer()
      const { wrapPort } = fakeWrapPort()
      const bridge = createSocketBridge({ ipcRenderer, portChannel: 'orivon:port', wrapPort, waitTimeoutMs: 100 })

      const waiting = bridge.waitForPort(HANDLE)
      ipcRenderer.emit({ handleId: HANDLE })
      await waiting

      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('createSocketBridge -- malformed deliveries are ignored, not thrown', () => {
  it.each([
    ['no handleId', {}],
    ['a non-string handleId', { handleId: 42 }]
  ])('%s does not throw and resolves nothing', (_label, payload) => {
    const ipcRenderer = fakeIpcRenderer()
    const { wrapPort } = fakeWrapPort()
    createSocketBridge({ ipcRenderer, portChannel: 'orivon:port', wrapPort })

    expect(() => { ipcRenderer.emit(payload) }).not.toThrow()
  })

  it('a delivery with no ports attached is ignored, not thrown', () => {
    const ipcRenderer = fakeIpcRenderer()
    const { wrapPort } = fakeWrapPort()
    createSocketBridge({ ipcRenderer, portChannel: 'orivon:port', wrapPort })

    expect(() => { ipcRenderer.emit({ handleId: HANDLE }, []) }).not.toThrow()
  })
})
