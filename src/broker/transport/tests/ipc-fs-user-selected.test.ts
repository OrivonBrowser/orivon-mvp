import { describe, expect, it, vi } from 'vitest'
import { handleControlRequest } from '../ipc.js'
import type { FsTransport } from '../dispatch-fs.js'
import { createPortRegistry } from '../port-registry.js'
import type { FailableDirectoryHandle, FailableFileHandle } from '../../handles/handle-contracts.js'
import { APP, OTHER, type BrokerCall, envelope, frameFor, stubBroker } from './ipc.test-helpers.js'

// `orivon.fs.userSelected` (A194) -- the FILE shape only, wired to a page
// once the wording gate (d-0032) cleared. Split out of ipc-fs-open.test.ts's
// own file, matching that file's own precedent (fs.open outgrew
// ipc-fs.test.ts; this concern gets the same treatment from the start).
//
// THE FOLDER SHAPE HAS ITS OWN FILE NOW (A195):
// ipc-fs-user-selected-directory.test.ts. It used to be refused here with
// 'internal' before the broker was ever called (A194's own gap); that
// refusal is gone -- DirectoryHandle's eight-method RPC surface reuses
// FileHandle's handle-scoped siblings for anything `dirOpen` returns, the
// same way FileHandle's own (fs.read/write/fstat/truncate/sync/close,
// already built for fs.open) are reused here for free.

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

// A person can take longer at the picker than the page was willing to wait.
// The page never learns these ids, so nothing else would ever close them.
describe('fs.userSelected -- a pick that lands after its request timed out', () => {
  function afterTimeout<T> (value: T): () => Promise<T> {
    return async () => await new Promise<T>((resolve) => { setTimeout(() => { resolve(value) }, 30) })
  }

  it('closes the picked files instead of registering them', async () => {
    const calls: BrokerCall[] = []
    const file = fakeFile({ id: 'late-1' })
    const broker = stubBroker(calls, { userSelected: afterTimeout([file]) })
    const fsTransport: FsTransport = { registry: createPortRegistry() }

    const response = await handleControlRequest(broker, frameFor(APP), envelope('fs.userSelected', {}, 5), undefined, undefined, undefined, fsTransport)
    await new Promise((resolve) => setTimeout(resolve, 60))

    expect(response).toMatchObject({ ok: false, code: 'timeout' })
    expect(file.close).toHaveBeenCalledTimes(1)
    expect(fsTransport.registry.get(APP, 'late-1')).toBeUndefined()
  })

  it('closes a picked folder the same way', async () => {
    const calls: BrokerCall[] = []
    const close = vi.fn(async () => {})
    const dir = { id: 'late-dir', close } as unknown as FailableDirectoryHandle
    const broker = stubBroker(calls, { userSelected: afterTimeout(dir) })
    const fsTransport: FsTransport = { registry: createPortRegistry(), dirRegistry: createPortRegistry() }

    await handleControlRequest(broker, frameFor(APP), envelope('fs.userSelected', { directory: true }, 5), undefined, undefined, undefined, fsTransport)
    await new Promise((resolve) => setTimeout(resolve, 60))

    expect(close).toHaveBeenCalledTimes(1)
    expect(fsTransport.dirRegistry?.get(APP, 'late-dir')).toBeUndefined()
  })
})
