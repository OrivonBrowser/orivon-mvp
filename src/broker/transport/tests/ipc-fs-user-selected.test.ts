import { describe, expect, it, vi } from 'vitest'
import { handleControlRequest } from '../ipc.js'
import type { FsTransport } from '../dispatch-fs.js'
import { createPortRegistry } from '../port-registry.js'
import type { FailableFileHandle } from '../../handles/handle-contracts.js'
import { APP, OTHER, type BrokerCall, envelope, frameFor, stubBroker } from './ipc.test-helpers.js'

// `orivon.fs.userSelected` (A194) -- the FILE shape only, wired to a page
// once the wording gate (d-0032) cleared. Split out of ipc-fs-open.test.ts's
// own file, matching that file's own precedent (fs.open outgrew
// ipc-fs.test.ts; this concern gets the same treatment from the start).
//
// THE FOLDER SHAPE HAS NO CASE HERE ON PURPOSE. `dispatch-fs.ts`'s own
// 'fs.userSelected' case refuses `directory: true` with 'internal' before
// the broker is ever called -- DirectoryHandle's eight-method RPC surface
// has no existing handle-scoped dispatch precedent to reuse, unlike
// FileHandle's (fs.read/write/fstat/truncate/sync/close, already built for
// fs.open, and reused here for free). See that case's own comment and A194
// (docs/open-questions.md) for the full reasoning; this file proves the
// refusal, not a workaround for it.

/** A minimal FailableFileHandle double -- same shape ipc-fs-open.test.ts's own fakeFile uses. */
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

describe('fs.userSelected -- the file shape, registers every returned handle', () => {
  it('a single-file pick resolves one { id } descriptor per handle and registers each', async () => {
    const calls: BrokerCall[] = []
    const file = fakeFile({ id: 'picked-1' })
    const broker = stubBroker(calls, { userSelected: async () => [file] })
    const fsTransport: FsTransport = { registry: createPortRegistry() }

    const response = await handleControlRequest(
      broker, frameFor(APP), envelope('fs.userSelected', {}),
      undefined, undefined, undefined, fsTransport
    )

    expect(response).toEqual({ id: 'req-1', ok: true, result: [{ id: 'picked-1' }] })
    expect(fsTransport.registry.get(APP, 'picked-1')).toBe(file)
    expect(calls).toEqual([{ method: 'fs.userSelected', origin: APP, args: undefined }])
  })

  it('a multi-file pick registers every handle and resolves one descriptor per file, in order', async () => {
    const calls: BrokerCall[] = []
    const first = fakeFile({ id: 'picked-a' })
    const second = fakeFile({ id: 'picked-b' })
    const broker = stubBroker(calls, { userSelected: async () => [first, second] })
    const fsTransport: FsTransport = { registry: createPortRegistry() }

    const response = await handleControlRequest(
      broker, frameFor(APP), envelope('fs.userSelected', { multiple: true }),
      undefined, undefined, undefined, fsTransport
    )

    expect(response).toEqual({ id: 'req-1', ok: true, result: [{ id: 'picked-a' }, { id: 'picked-b' }] })
    expect(fsTransport.registry.get(APP, 'picked-a')).toBe(first)
    expect(fsTransport.registry.get(APP, 'picked-b')).toBe(second)
    expect(calls).toEqual([{ method: 'fs.userSelected', origin: APP, args: { multiple: true } }])
  })

  it('a cancelled picker resolves an empty array, never a rejection -- capability-api.ts\'s own cancel contract', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { userSelected: async () => [] })
    const fsTransport: FsTransport = { registry: createPortRegistry() }

    const response = await handleControlRequest(
      broker, frameFor(APP), envelope('fs.userSelected', {}),
      undefined, undefined, undefined, fsTransport
    )

    expect(response).toEqual({ id: 'req-1', ok: true, result: [] })
  })

  it('registers an onUnlink listener per handle that removes just that entry when the handle leaves the broker\'s tables', async () => {
    const calls: BrokerCall[] = []
    let unlinkListener: (() => void) | undefined
    const file = fakeFile({ id: 'picked-1', onUnlink: vi.fn((listener) => { unlinkListener = listener }) })
    const broker = stubBroker(calls, { userSelected: async () => [file] })
    const fsTransport: FsTransport = { registry: createPortRegistry() }

    await handleControlRequest(
      broker, frameFor(APP), envelope('fs.userSelected', {}),
      undefined, undefined, undefined, fsTransport
    )
    expect(fsTransport.registry.get(APP, 'picked-1')).toBe(file)

    unlinkListener?.()

    expect(fsTransport.registry.get(APP, 'picked-1')).toBeUndefined()
  })

  it('fails as internal, not a crash, when no fsTransport is configured', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { userSelected: async () => [fakeFile()] })

    const response = await handleControlRequest(broker, frameFor(APP), envelope('fs.userSelected', {}))

    expect(response).toMatchObject({ ok: false, code: 'internal' })
  })

  it('a picked file\'s id is usable through the SAME fs.read/write/close cases fs.open already wired', async () => {
    const calls: BrokerCall[] = []
    const file = fakeFile({ id: 'picked-1', read: vi.fn(async () => new Uint8Array([9])) })
    const broker = stubBroker(calls, { userSelected: async () => [file] })
    const fsTransport: FsTransport = { registry: createPortRegistry() }

    await handleControlRequest(
      broker, frameFor(APP), envelope('fs.userSelected', {}),
      undefined, undefined, undefined, fsTransport
    )
    const response = await handleControlRequest(
      broker, frameFor(APP), envelope('fs.read', { id: 'picked-1', position: 0, length: 1 }),
      undefined, undefined, undefined, fsTransport
    )

    expect(response).toEqual({ id: 'req-1', ok: true, result: new Uint8Array([9]) })
  })
})

describe('fs.userSelected -- the denied path', () => {
  it('a page reusing a picked-file id after it has been unlinked (revoked or closed) is denied, never silently reads stale data', async () => {
    const calls: BrokerCall[] = []
    let unlinkListener: (() => void) | undefined
    const file = fakeFile({ id: 'picked-1', onUnlink: vi.fn((listener) => { unlinkListener = listener }) })
    const broker = stubBroker(calls, { userSelected: async () => [file] })
    const fsTransport: FsTransport = { registry: createPortRegistry() }

    await handleControlRequest(
      broker, frameFor(APP), envelope('fs.userSelected', {}),
      undefined, undefined, undefined, fsTransport
    )
    // Models the pick's own revocation -- handles.ts's `revokeUserSelected`
    // unlinks the handle, which fires this same listener in production.
    unlinkListener?.()

    const response = await handleControlRequest(
      broker, frameFor(APP), envelope('fs.read', { id: 'picked-1', position: 0, length: 1 }),
      undefined, undefined, undefined, fsTransport
    )

    expect(response).toMatchObject({ ok: false, code: 'denied' })
  })

  it('a picked-file id belonging to a DIFFERENT origin is denied (T11c), matching fs.open\'s own precedent', async () => {
    const file = fakeFile({ id: 'picked-1' })
    const fsTransport: FsTransport = { registry: createPortRegistry() }
    fsTransport.registry.register(OTHER, 'picked-1', file)

    const response = await handleControlRequest(
      stubBroker([]), frameFor(APP), envelope('fs.read', { id: 'picked-1', position: 0, length: 1 }),
      undefined, undefined, undefined, fsTransport
    )

    expect(response).toMatchObject({ ok: false, code: 'denied' })
  })

  it('the folder shape (directory: true) is refused as internal, before the broker is ever called -- see this file\'s own header, A194', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls)

    const response = await handleControlRequest(broker, frameFor(APP), envelope('fs.userSelected', { directory: true }))

    expect(response).toMatchObject({ ok: false, code: 'internal' })
    expect(calls).toEqual([])
  })

  it.each<[string, unknown]>([
    ['fs.userSelected', { directory: 'yes' }],
    ['fs.userSelected', { multiple: 'yes' }],
    ['fs.userSelected', { directory: 1 }]
  ])('%s rejects a malformed payload as invalid, without calling the broker', async (method, payload) => {
    const calls: BrokerCall[] = []
    const response = await handleControlRequest(stubBroker(calls), frameFor(APP), envelope(method, payload))
    expect(response).toMatchObject({ ok: false, code: 'invalid' })
    expect(calls).toEqual([])
  })
})
