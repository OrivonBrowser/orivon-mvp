import { describe, expect, it, vi } from 'vitest'

// The consent prompts ask through askQuestion; nothing here opens a question,
// so it is replaced outright. `session.defaultSession` is touched
// unconditionally, once broker/loader are both present, to register the
// default session's one granted-origin CSP handler -- a bare fake webRequest
// is enough, since no test here inspects what got registered.
vi.mock('../../shell/question/ask-question.js', () => ({ askQuestion: vi.fn(async () => ({ response: 1, checkboxChecked: false })) }))
vi.mock('electron', () => ({
  session: { defaultSession: { webRequest: { onHeadersReceived: vi.fn(), onBeforeRequest: vi.fn(), onBeforeSendHeaders: vi.fn() } } }
}))

const { appInstallSubsystem, readCapped } = await import('../app-install-subsystem.js')
const { createSubsystemContext, publishBroker, publishLoader } = await import('../../registry.js')
const { stubBroker } = await import('../../../broker/transport/tests/ipc.test-helpers.js')

import type { App } from 'electron'
import type { Broker } from '../../../broker/broker-contracts.js'
import type { Loader } from '../../../loader/index.js'

const fakeApp = {} as unknown as App
const fakeLoader: Loader = {
  load: async () => ({ outcome: 'rejected', reason: 'unused' }),
  installFetched: async () => { throw new Error('installFetched was not stubbed for this test') },
  reconsider: async () => { throw new Error('reconsider was not stubbed for this test') },
  pinFor: async () => null,
  ddocFor: async () => undefined,
  applyUpdate: async () => ({ outcome: 'rejected' as const, reason: 'unused' }),
  quietOffers: async () => ({ quiet: [] }),
  keepQuiet: async () => {},
  manifestFor: async () => undefined,
  manifestAt: async () => ({ kind: 'website' as const })
}

describe('appInstallSubsystem', () => {
  it('throws when ctx.broker is undefined -- must be listed after brokerIpcSubsystem', () => {
    const ctx = createSubsystemContext(fakeApp)
    expect(() => appInstallSubsystem.afterReady?.(ctx)).toThrow(/ctx\.broker/)
  })

  it('throws when ctx.loader is undefined -- must be listed after loaderSubsystem', () => {
    const ctx = createSubsystemContext(fakeApp)
    publishBroker(ctx, stubBroker([]) as unknown as Broker)
    expect(() => appInstallSubsystem.afterReady?.(ctx)).toThrow(/ctx\.loader/)
  })

  it('publishes an installApp function on ctx once both broker and loader are present', async () => {
    const ctx = createSubsystemContext(fakeApp)
    publishBroker(ctx, stubBroker([]) as unknown as Broker)
    publishLoader(ctx, fakeLoader)

    await appInstallSubsystem.afterReady?.(ctx)

    expect(ctx.installApp).toBeTypeOf('function')
  })

  it('is not marked critical -- an unwired install path must never take the real browser down', () => {
    expect(appInstallSubsystem.critical).not.toBe(true)
  })
})

// fetchGrantManifest never reads a loopback server's whole response body to
// a string before grantWithoutInstall's own MAX_MANIFEST_BYTES check runs --
// readCapped enforces that, exercised here directly against a real streamed
// Response rather than through the whole subsystem.
describe('readCapped', () => {
  function streamed (chunks: readonly string[]): Response {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start (controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      }
    })
    return new Response(stream)
  }

  it('reads the whole body when it fits under the cap', async () => {
    expect(await readCapped(streamed(['hello', ' ', 'world']), 1024)).toBe('hello world')
  })

  it('stops reading, never decoding more than a few bytes past the cap, for a body far larger than it', async () => {
    const bigChunk = 'x'.repeat(1_000_000)
    const response = streamed([bigChunk, bigChunk, bigChunk]) // 3 MB total
    const text = await readCapped(response, 10)
    // Stops the first time the running total crosses the cap -- one 1 MB
    // chunk here, not all 3 MB, and never the unbounded body a hostile
    // server could keep streaming forever.
    expect(text.length).toBe(1_000_000)
    expect(text.length).toBeLessThan(3_000_000)
  })

  it('cancels the stream rather than draining it once the cap is crossed', async () => {
    let cancelled = false
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start (controller) {
        controller.enqueue(encoder.encode('x'.repeat(100)))
        controller.enqueue(encoder.encode('y'.repeat(100)))
      },
      cancel () { cancelled = true }
    })
    await readCapped(new Response(stream), 10)
    expect(cancelled).toBe(true)
  })
})
