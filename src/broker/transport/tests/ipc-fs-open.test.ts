import { describe, expect, it, vi } from 'vitest'
import { handleControlRequest } from '../ipc.js'
import type { FsTransport } from '../dispatch-fs.js'
import { createPortRegistry } from '../port-registry.js'
import type { FailableFileHandle } from '../../handles/handle-contracts.js'
import { APP, OTHER, type BrokerCall, envelope, frameFor, stubBroker } from './ipc.test-helpers.js'

// `orivon.fs.open` (A184) and its handle-scoped siblings -- fs.read, fs.write,
// fs.fstat, fs.truncate, fs.sync, fs.close -- split out of ipc-fs.test.ts
// under code-guidelines.md's 800-line test limit, matching that file's own
// precedent for a control method outgrowing it.
//
// THIS FILE PROVES DISPATCH AND THE REGISTRY WIRING ONLY -- that fs.open
// registers the handle fs.read/write/... can then find by id, that an id
// belonging to a DIFFERENT origin is refused (T11c), and that fs.close's
// contract is idempotent while every other op is not. Confinement, the
// grant, quota and revocation are fs-open.test.ts's job, against the real
// createBroker/fs-capability.ts stack -- a stubBroker here has none of that
// to get wrong.

/** A minimal FailableFileHandle double -- enough to prove dispatch calls the right method with the right arguments. */
function fakeFile (overrides: Partial<FailableFileHandle> = {}): FailableFileHandle {
  return {
    id: 'file-1',
    closed: new Promise(() => {}),
    close: vi.fn(async () => {}),
    fail: vi.fn(),
    onUnlink: vi.fn(),
    read: vi.fn(async () => new Uint8Array([1, 2, 3])),
    write: vi.fn(async () => 3),
    readable: vi.fn(() => new ReadableStream()),
    writable: vi.fn(() => new WritableStream()),
    stat: vi.fn(async () => ({ size: 3, isFile: true, isDirectory: false, mtimeMs: 0 })),
    truncate: vi.fn(async () => {}),
    sync: vi.fn(async () => {}),
    ...overrides
  }
}

describe('fs.open registers the returned handle for this origin', () => {
  it('resolves a bare { id } descriptor and registers it in fsTransport.registry', async () => {
    const calls: BrokerCall[] = []
    const file = fakeFile({ id: 'abc123' })
    const broker = stubBroker(calls, { open: async () => file })
    const fsTransport: FsTransport = { registry: createPortRegistry() }

    const response = await handleControlRequest(
      broker, frameFor(APP), envelope('fs.open', { path: 'piece.bin', flags: 'w+' }),
      undefined, undefined, undefined, fsTransport
    )

    expect(response).toEqual({ id: 'req-1', ok: true, result: { id: 'abc123' } })
    expect(fsTransport.registry.get(APP, 'abc123')).toBe(file)
    expect(calls).toEqual([{ method: 'fs.open', origin: APP, args: { path: 'piece.bin', flags: 'w+' } }])
  })

  it('registers an onUnlink listener that removes the entry when the handle leaves the broker\'s tables', async () => {
    const calls: BrokerCall[] = []
    let unlinkListener: (() => void) | undefined
    const file = fakeFile({ id: 'abc123', onUnlink: vi.fn((listener) => { unlinkListener = listener }) })
    const broker = stubBroker(calls, { open: async () => file })
    const fsTransport: FsTransport = { registry: createPortRegistry() }

    await handleControlRequest(
      broker, frameFor(APP), envelope('fs.open', { path: 'piece.bin', flags: 'w+' }),
      undefined, undefined, undefined, fsTransport
    )
    expect(fsTransport.registry.get(APP, 'abc123')).toBe(file)

    unlinkListener?.()

    expect(fsTransport.registry.get(APP, 'abc123')).toBeUndefined()
  })

  it('fails as internal, not a crash, when no fsTransport is configured', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { open: async () => fakeFile() })

    const response = await handleControlRequest(broker, frameFor(APP), envelope('fs.open', { path: 'a', flags: 'r' }))

    expect(response).toMatchObject({ ok: false, code: 'internal' })
  })

  it.each<[string, unknown]>([
    ['fs.open', {}],
    ['fs.open', { path: '/a' }],
    ['fs.open', { flags: 'r' }],
    ['fs.open', { path: 42, flags: 'r' }],
    ['fs.open', { path: '/a', flags: 42 }]
  ])('%s rejects a malformed payload as invalid, without calling the broker', async (method, payload) => {
    const calls: BrokerCall[] = []
    const response = await handleControlRequest(stubBroker(calls), frameFor(APP), envelope(method, payload))
    expect(response).toMatchObject({ ok: false, code: 'invalid' })
    expect(calls).toEqual([])
  })
})

describe('fs.read / fs.write / fs.fstat / fs.truncate / fs.sync -- the ownership check (T11c)', () => {
  it('fs.read passes position/length through and returns the bytes', async () => {
    const file = fakeFile({ id: 'h1', read: vi.fn(async () => new Uint8Array([7, 8])) })
    const fsTransport: FsTransport = { registry: createPortRegistry() }
    fsTransport.registry.register(APP, 'h1', file)

    const response = await handleControlRequest(
      stubBroker([]), frameFor(APP), envelope('fs.read', { id: 'h1', position: 10, length: 2 }),
      undefined, undefined, undefined, fsTransport
    )

    expect(response).toEqual({ id: 'req-1', ok: true, result: new Uint8Array([7, 8]) })
    expect(file.read).toHaveBeenCalledWith({ position: 10, length: 2 })
  })

  it('fs.write passes position/data through and returns bytesWritten', async () => {
    const file = fakeFile({ id: 'h1', write: vi.fn(async () => 4) })
    const fsTransport: FsTransport = { registry: createPortRegistry() }
    fsTransport.registry.register(APP, 'h1', file)
    const data = new Uint8Array([1, 2, 3, 4])

    const response = await handleControlRequest(
      stubBroker([]), frameFor(APP), envelope('fs.write', { id: 'h1', position: 0, data }),
      undefined, undefined, undefined, fsTransport
    )

    expect(response).toEqual({ id: 'req-1', ok: true, result: 4 })
    expect(file.write).toHaveBeenCalledWith({ position: 0, data })
  })

  it('fs.fstat returns the handle\'s own stat result', async () => {
    const stat = { size: 9, isFile: true, isDirectory: false, mtimeMs: 42 }
    const file = fakeFile({ id: 'h1', stat: vi.fn(async () => stat) })
    const fsTransport: FsTransport = { registry: createPortRegistry() }
    fsTransport.registry.register(APP, 'h1', file)

    const response = await handleControlRequest(
      stubBroker([]), frameFor(APP), envelope('fs.fstat', { id: 'h1' }),
      undefined, undefined, undefined, fsTransport
    )

    expect(response).toEqual({ id: 'req-1', ok: true, result: stat })
  })

  it('fs.truncate passes length through and resolves undefined', async () => {
    const file = fakeFile({ id: 'h1' })
    const fsTransport: FsTransport = { registry: createPortRegistry() }
    fsTransport.registry.register(APP, 'h1', file)

    const response = await handleControlRequest(
      stubBroker([]), frameFor(APP), envelope('fs.truncate', { id: 'h1', length: 5 }),
      undefined, undefined, undefined, fsTransport
    )

    expect(response).toEqual({ id: 'req-1', ok: true, result: undefined })
    expect(file.truncate).toHaveBeenCalledWith(5)
  })

  it('fs.sync resolves undefined and calls the handle\'s own sync', async () => {
    const file = fakeFile({ id: 'h1' })
    const fsTransport: FsTransport = { registry: createPortRegistry() }
    fsTransport.registry.register(APP, 'h1', file)

    const response = await handleControlRequest(
      stubBroker([]), frameFor(APP), envelope('fs.sync', { id: 'h1' }),
      undefined, undefined, undefined, fsTransport
    )

    expect(response).toEqual({ id: 'req-1', ok: true, result: undefined })
    expect(file.sync).toHaveBeenCalledOnce()
  })

  it.each(['fs.read', 'fs.write', 'fs.fstat', 'fs.truncate', 'fs.sync'])(
    '%s is denied for a handle id this origin was never handed, never silently ignored',
    async (method) => {
      const file = fakeFile({ id: 'h1' })
      const fsTransport: FsTransport = { registry: createPortRegistry() }
      // Registered under a DIFFERENT origin -- OTHER's own id, presented by APP.
      fsTransport.registry.register(OTHER, 'h1', file)
      const payload = method === 'fs.write'
        ? { id: 'h1', position: 0, data: new Uint8Array(1) }
        : method === 'fs.truncate'
          ? { id: 'h1', length: 0 }
          : method === 'fs.read'
            ? { id: 'h1', position: 0, length: 1 }
            : { id: 'h1' }

      const response = await handleControlRequest(
        stubBroker([]), frameFor(APP), envelope(method, payload),
        undefined, undefined, undefined, fsTransport
      )

      expect(response).toMatchObject({ ok: false, code: 'denied' })
    }
  )

  it.each<[string, unknown]>([
    ['fs.read', { id: 'h1' }],
    ['fs.read', { id: 'h1', position: -1, length: 1 }],
    ['fs.read', { id: 'h1', position: 0, length: -1 }],
    ['fs.write', { id: 'h1', position: 0 }],
    ['fs.write', { id: 'h1', position: -1, data: new Uint8Array(1) }],
    ['fs.write', { id: 'h1', position: 0, data: 'not bytes' }],
    ['fs.fstat', {}],
    ['fs.truncate', { id: 'h1' }],
    ['fs.truncate', { id: 'h1', length: -1 }],
    ['fs.sync', {}],
    ['fs.close', {}]
  ])('%s rejects a malformed payload as invalid, without touching the registry', async (method, payload) => {
    const fsTransport: FsTransport = { registry: createPortRegistry() }
    const response = await handleControlRequest(
      stubBroker([]), frameFor(APP), envelope(method, payload),
      undefined, undefined, undefined, fsTransport
    )
    expect(response).toMatchObject({ ok: false, code: 'invalid' })
  })
})

describe('fs.close -- idempotent, the one silent no-op (matching Handle.close()\'s own contract)', () => {
  it('closes a live handle and is safe to call again for the same id', async () => {
    const file = fakeFile({ id: 'h1' })
    const fsTransport: FsTransport = { registry: createPortRegistry() }
    fsTransport.registry.register(APP, 'h1', file)

    const first = await handleControlRequest(
      stubBroker([]), frameFor(APP), envelope('fs.close', { id: 'h1' }),
      undefined, undefined, undefined, fsTransport
    )
    expect(first).toEqual({ id: 'req-1', ok: true, result: undefined })
    expect(file.close).toHaveBeenCalledOnce()

    const second = await handleControlRequest(
      stubBroker([]), frameFor(APP), envelope('fs.close', { id: 'h1' }),
      undefined, undefined, undefined, fsTransport
    )
    expect(second).toEqual({ id: 'req-1', ok: true, result: undefined })
  })

  it('closing an id this origin never held, or one from another origin, is a silent success -- not a probe surface', async () => {
    const file = fakeFile({ id: 'h1' })
    const fsTransport: FsTransport = { registry: createPortRegistry() }
    fsTransport.registry.register(OTHER, 'h1', file)

    const response = await handleControlRequest(
      stubBroker([]), frameFor(APP), envelope('fs.close', { id: 'h1' }),
      undefined, undefined, undefined, fsTransport
    )

    expect(response).toEqual({ id: 'req-1', ok: true, result: undefined })
    expect(file.close).not.toHaveBeenCalled()
  })
})
