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

function fakeSession (): { on: ReturnType<typeof vi.fn>, webRequest: { onBeforeRequest: ReturnType<typeof vi.fn> } } {
  return { on: vi.fn(), webRequest: { onBeforeRequest: vi.fn() } }
}

vi.mock('electron', () => ({
  app: fakeApp,
  session: { fromPartition: vi.fn(() => fakeSession()) }
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

describe('installEmbedHost -- the embedder origin captured at will-attach-webview reaches did-attach-webview (R7-07)', () => {
  // fakeApp is one EventEmitter shared by the whole file (vi.mock runs
  // once); each test's own installEmbedHost() call must not leave its
  // 'web-contents-created' listener wired for the NEXT test's embedder.
  beforeEach(() => { fakeApp.removeAllListeners() })

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
})
