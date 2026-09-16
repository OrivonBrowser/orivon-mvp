import { describe, expect, it, vi } from 'vitest'
import { handleControlRequest } from '../ipc.js'
import type { FsTransport } from '../dispatch-fs.js'
import { createPortRegistry } from '../port-registry.js'
import { fail } from '../../errors.js'
import type { FailableDirectoryHandle, FailableFileHandle } from '../../handles/handle-contracts.js'
import { APP, OTHER, type BrokerCall, envelope, frameFor, stubBroker } from './ipc.test-helpers.js'

// `orivon.fs.userSelected`'s FOLDER shape (A195, closing A194) -- the nine
// DirectoryHandle members (contracts/handles.ts) reaching a page over
// CONTROL_CHANNEL: an acquisition case (fs.userSelected with { directory:
// true }) plus eight handle-scoped verbs (fs.dir*). `fs.dirOpen` is the one
// that registers into the SAME fsTransport.registry fs.open/fs.userSelected's
// file shape already use -- no second file-handle mechanism, per this
// lane's own brief.
//
// THIS FILE PROVES DISPATCH AND THE REGISTRY WIRING ONLY, matching
// ipc-fs-open.test.ts's own drawn line: confinement, the real revocation
// cascade and the real quota accounting are src/broker/tests/user-
// selected.test.ts's job, against the real createBroker/user-selected-
// capability.ts stack. A `FailableDirectoryHandle` double here has none of
// that to get wrong -- what IS this layer's to get wrong is whether a
// broker-produced 'denied'/'limit' survives the trip through dispatch
// unmangled, and whether THIS layer's own onUnlink wiring tears down the
// right dispatch-level registry entries when the broker signals a handle is
// gone. Both are exercised below by firing a fake handle's onUnlink
// callback directly -- exactly the mechanism `handleTable`'s real
// revocation walk uses in production (handle-contracts.md's "Revocation"
// section), and exactly what ipc-fs-user-selected.test.ts's own file-shape
// tests already do for FileHandle.

/** A minimal FailableFileHandle double -- same shape ipc-fs-open.test.ts's own fakeFile uses. */
function fakeFile (overrides: Partial<FailableFileHandle> = {}): FailableFileHandle {
  return {
    id: 'opened-file-1',
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

/** A minimal FailableDirectoryHandle double -- enough to prove dispatch calls the right method with the right arguments and propagates whatever it resolves or rejects. */
function fakeDir (overrides: Partial<FailableDirectoryHandle> = {}): FailableDirectoryHandle {
  return {
    id: 'dir-1',
    closed: new Promise(() => {}),
    close: vi.fn(async () => {}),
    fail: vi.fn(),
    onUnlink: vi.fn(),
    readdir: vi.fn(async () => ['a.txt']),
    stat: vi.fn(async () => ({ size: 0, isFile: false, isDirectory: true, mtimeMs: 0 })),
    mkdir: vi.fn(async () => {}),
    rm: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    readFile: vi.fn(async () => new Uint8Array([7])),
    writeFile: vi.fn(async () => {}),
    open: vi.fn(async () => fakeFile()),
    ...overrides
  }
}

/** Builds an empty FsTransport with both registries -- the shape ./ipc.ts's brokerIpcSubsystem constructs for real. */
function fsTransport (): FsTransport {
  return { registry: createPortRegistry(), dirRegistry: createPortRegistry() }
}

describe('fs.userSelected -- the folder shape, registers the returned handle', () => {
  it('a folder pick resolves one { id } descriptor and registers it in fsTransport.dirRegistry', async () => {
    const calls: BrokerCall[] = []
    const dir = fakeDir({ id: 'picked-dir' })
    const broker = stubBroker(calls, { userSelected: async () => dir })
    const transport = fsTransport()

    const response = await handleControlRequest(
      broker, frameFor(APP), envelope('fs.userSelected', { directory: true }),
      undefined, undefined, undefined, transport
    )

    expect(response).toEqual({ id: 'req-1', ok: true, result: { id: 'picked-dir' } })
    expect(transport.dirRegistry?.get(APP, 'picked-dir')).toBe(dir)
    expect(calls).toEqual([{ method: 'fs.userSelected', origin: APP, args: { directory: true } }])
  })

  it('resolves null, never a rejection, when the dialog is cancelled -- capability-api.ts\'s own folder cancel contract', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { userSelected: async () => null })
    const transport = fsTransport()

    const response = await handleControlRequest(
      broker, frameFor(APP), envelope('fs.userSelected', { directory: true }),
      undefined, undefined, undefined, transport
    )

    expect(response).toEqual({ id: 'req-1', ok: true, result: null })
  })

  it('registers an onUnlink listener that removes just that entry when the handle leaves the broker\'s tables', async () => {
    const calls: BrokerCall[] = []
    let unlinkListener: (() => void) | undefined
    const dir = fakeDir({ id: 'picked-dir', onUnlink: vi.fn((listener) => { unlinkListener = listener }) })
    const broker = stubBroker(calls, { userSelected: async () => dir })
    const transport = fsTransport()

    await handleControlRequest(
      broker, frameFor(APP), envelope('fs.userSelected', { directory: true }),
      undefined, undefined, undefined, transport
    )
    expect(transport.dirRegistry?.get(APP, 'picked-dir')).toBe(dir)

    unlinkListener?.()

    expect(transport.dirRegistry?.get(APP, 'picked-dir')).toBeUndefined()
  })

  it('fails as internal, not a crash, when no fsTransport is configured at all', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { userSelected: async () => fakeDir() })

    const response = await handleControlRequest(broker, frameFor(APP), envelope('fs.userSelected', { directory: true }))

    expect(response).toMatchObject({ ok: false, code: 'internal' })
  })

  it('fails as internal when fsTransport exists but has no dirRegistry -- the optional-field fallback fails closed, not open', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { userSelected: async () => fakeDir() })
    const transport: FsTransport = { registry: createPortRegistry() } // no dirRegistry

    const response = await handleControlRequest(
      broker, frameFor(APP), envelope('fs.userSelected', { directory: true }),
      undefined, undefined, undefined, transport
    )

    expect(response).toMatchObject({ ok: false, code: 'internal' })
  })
})

describe('DirectoryHandle -- each of the nine members reaches a page', () => {
  it('fs.dirReaddir forwards the optional path and resolves the entry list', async () => {
    const dir = fakeDir({ readdir: vi.fn(async () => ['a.txt', 'b.txt']) })
    const transport = fsTransport()
    transport.dirRegistry?.register(APP, 'dir-1', dir)

    const response = await handleControlRequest(
      dummyBroker(), frameFor(APP), envelope('fs.dirReaddir', { id: 'dir-1', path: 'sub' }),
      undefined, undefined, undefined, transport
    )

    expect(response).toEqual({ id: 'req-1', ok: true, result: ['a.txt', 'b.txt'] })
    expect(dir.readdir).toHaveBeenCalledWith('sub')
  })

  it('fs.dirReaddir omitting path targets the root -- matches DirectoryHandle.readdir\'s own contract', async () => {
    const dir = fakeDir()
    const transport = fsTransport()
    transport.dirRegistry?.register(APP, 'dir-1', dir)

    await handleControlRequest(
      dummyBroker(), frameFor(APP), envelope('fs.dirReaddir', { id: 'dir-1' }),
      undefined, undefined, undefined, transport
    )

    expect(dir.readdir).toHaveBeenCalledWith(undefined)
  })

  it('fs.dirStat forwards the optional path and resolves the FileStat', async () => {
    const dir = fakeDir({ stat: vi.fn(async () => ({ size: 5, isFile: false, isDirectory: true, mtimeMs: 1 })) })
    const transport = fsTransport()
    transport.dirRegistry?.register(APP, 'dir-1', dir)

    const response = await handleControlRequest(
      dummyBroker(), frameFor(APP), envelope('fs.dirStat', { id: 'dir-1', path: 'sub' }),
      undefined, undefined, undefined, transport
    )

    expect(response).toEqual({ id: 'req-1', ok: true, result: { size: 5, isFile: false, isDirectory: true, mtimeMs: 1 } })
    expect(dir.stat).toHaveBeenCalledWith('sub')
  })

  it('fs.dirMkdir forwards path and recursive', async () => {
    const dir = fakeDir()
    const transport = fsTransport()
    transport.dirRegistry?.register(APP, 'dir-1', dir)

    const response = await handleControlRequest(
      dummyBroker(), frameFor(APP), envelope('fs.dirMkdir', { id: 'dir-1', path: 'sub', recursive: true }),
      undefined, undefined, undefined, transport
    )

    expect(response).toEqual({ id: 'req-1', ok: true, result: undefined })
    expect(dir.mkdir).toHaveBeenCalledWith('sub', { recursive: true })
  })

  it('fs.dirRm forwards path and recursive', async () => {
    const dir = fakeDir()
    const transport = fsTransport()
    transport.dirRegistry?.register(APP, 'dir-1', dir)

    await handleControlRequest(
      dummyBroker(), frameFor(APP), envelope('fs.dirRm', { id: 'dir-1', path: 'sub' }),
      undefined, undefined, undefined, transport
    )

    expect(dir.rm).toHaveBeenCalledWith('sub', undefined)
  })

  it('fs.dirRename forwards from and to', async () => {
    const dir = fakeDir()
    const transport = fsTransport()
    transport.dirRegistry?.register(APP, 'dir-1', dir)

    await handleControlRequest(
      dummyBroker(), frameFor(APP), envelope('fs.dirRename', { id: 'dir-1', from: 'a.txt', to: 'b.txt' }),
      undefined, undefined, undefined, transport
    )

    expect(dir.rename).toHaveBeenCalledWith('a.txt', 'b.txt')
  })

  it('fs.dirReadFile forwards path and resolves the bytes', async () => {
    const dir = fakeDir({ readFile: vi.fn(async () => new Uint8Array([1, 2])) })
    const transport = fsTransport()
    transport.dirRegistry?.register(APP, 'dir-1', dir)

    const response = await handleControlRequest(
      dummyBroker(), frameFor(APP), envelope('fs.dirReadFile', { id: 'dir-1', path: 'a.txt' }),
      undefined, undefined, undefined, transport
    )

    expect(response).toEqual({ id: 'req-1', ok: true, result: new Uint8Array([1, 2]) })
  })

  it('fs.dirWriteFile forwards path and data', async () => {
    const dir = fakeDir()
    const transport = fsTransport()
    transport.dirRegistry?.register(APP, 'dir-1', dir)
    const data = new Uint8Array([9, 9])

    await handleControlRequest(
      dummyBroker(), frameFor(APP), envelope('fs.dirWriteFile', { id: 'dir-1', path: 'a.txt', data }),
      undefined, undefined, undefined, transport
    )

    expect(dir.writeFile).toHaveBeenCalledWith('a.txt', data)
  })

  it('fs.dirOpen registers the returned FileHandle in the SAME fsTransport.registry fs.open uses -- no second file-handle mechanism', async () => {
    const openedFile = fakeFile({ id: 'file-from-dir', read: vi.fn(async () => new Uint8Array([42])) })
    const dir = fakeDir({ open: vi.fn(async () => openedFile) })
    const transport = fsTransport()
    transport.dirRegistry?.register(APP, 'dir-1', dir)

    const openResponse = await handleControlRequest(
      dummyBroker(), frameFor(APP), envelope('fs.dirOpen', { id: 'dir-1', path: 'piece.bin', flags: 'w+' }),
      undefined, undefined, undefined, transport
    )

    expect(openResponse).toEqual({ id: 'req-1', ok: true, result: { id: 'file-from-dir' } })
    expect(dir.open).toHaveBeenCalledWith('piece.bin', 'w+')
    expect(transport.registry.get(APP, 'file-from-dir')).toBe(openedFile)

    // The whole point of routing through the existing mechanism: the SAME
    // fs.read case fs.open already wired serves this id, with no dirOpen-
    // specific read path anywhere.
    const readResponse = await handleControlRequest(
      dummyBroker(), frameFor(APP), envelope('fs.read', { id: 'file-from-dir', position: 0, length: 1 }),
      undefined, undefined, undefined, transport
    )
    expect(readResponse).toEqual({ id: 'req-1', ok: true, result: new Uint8Array([42]) })
  })

  it('fs.close closes a directory id -- one method for either kind, since a page never knows which it is holding', async () => {
    const dir = fakeDir()
    const transport = fsTransport()
    transport.dirRegistry?.register(APP, 'dir-1', dir)

    const response = await handleControlRequest(
      dummyBroker(), frameFor(APP), envelope('fs.close', { id: 'dir-1' }),
      undefined, undefined, undefined, transport
    )

    expect(response).toEqual({ id: 'req-1', ok: true, result: undefined })
    expect(dir.close).toHaveBeenCalledOnce()
  })

  it('fs.close on an unknown id is a silent idempotent no-op, matching Handle.close()\'s own contract', async () => {
    const transport = fsTransport()

    const response = await handleControlRequest(
      dummyBroker(), frameFor(APP), envelope('fs.close', { id: 'never-registered' }),
      undefined, undefined, undefined, transport
    )

    expect(response).toEqual({ id: 'req-1', ok: true, result: undefined })
  })
})

describe('DirectoryHandle -- the denied path (T11c + confinement propagation)', () => {
  it('an unknown directory id is denied, never a crash', async () => {
    const transport = fsTransport()

    const response = await handleControlRequest(
      dummyBroker(), frameFor(APP), envelope('fs.dirReaddir', { id: 'never-registered' }),
      undefined, undefined, undefined, transport
    )

    expect(response).toMatchObject({ ok: false, code: 'denied' })
  })

  it('a directory id belonging to a DIFFERENT origin is denied (T11c)', async () => {
    const dir = fakeDir()
    const transport = fsTransport()
    transport.dirRegistry?.register(OTHER, 'dir-1', dir)

    const response = await handleControlRequest(
      dummyBroker(), frameFor(APP), envelope('fs.dirReaddir', { id: 'dir-1' }),
      undefined, undefined, undefined, transport
    )

    expect(response).toMatchObject({ ok: false, code: 'denied' })
  })

  it('a traversal attempt under the picked folder -- the broker\'s own confinement refusal -- crosses as \'denied\' unmangled, never swallowed or recoded', async () => {
    const dir = fakeDir({
      readFile: vi.fn(async () => { throw fail('denied', 'the path is outside the picked folder') })
    })
    const transport = fsTransport()
    transport.dirRegistry?.register(APP, 'dir-1', dir)

    const response = await handleControlRequest(
      dummyBroker(), frameFor(APP), envelope('fs.dirReadFile', { id: 'dir-1', path: '../../../etc/passwd' }),
      undefined, undefined, undefined, transport
    )

    expect(response).toMatchObject({ ok: false, code: 'denied' })
    // 'denied' never carries a platformCode or a reason-specific message
    // across the wire (errors.ts's own "denied never varies by reason"
    // rule, response-envelope.ts) -- confirmed here rather than assumed.
    expect(response).not.toHaveProperty('platformCode')
  })

  it('fs.dirOpen fails as internal when no fsTransport is configured -- matches fs.open\'s own precedent', async () => {
    const response = await handleControlRequest(
      dummyBroker(), frameFor(APP), envelope('fs.dirOpen', { id: 'dir-1', path: 'a.bin', flags: 'r+' })
    )

    expect(response).toMatchObject({ ok: false, code: 'internal' })
  })

  it.each<[string, unknown]>([
    ['fs.dirReaddir', { id: 1 }],
    ['fs.dirStat', { id: 'dir-1', path: 5 }],
    ['fs.dirMkdir', { id: 'dir-1' }],
    ['fs.dirRm', {}],
    ['fs.dirRename', { id: 'dir-1', from: 'a' }],
    ['fs.dirReadFile', { id: 'dir-1' }],
    ['fs.dirWriteFile', { id: 'dir-1', path: 'a' }],
    ['fs.dirOpen', { id: 'dir-1', path: 'a' }]
  ])('%s rejects a malformed payload as invalid, without touching the registry', async (method, payload) => {
    const transport = fsTransport()
    const dir = fakeDir()
    transport.dirRegistry?.register(APP, 'dir-1', dir)

    const response = await handleControlRequest(
      dummyBroker(), frameFor(APP), envelope(method, payload),
      undefined, undefined, undefined, transport
    )

    expect(response).toMatchObject({ ok: false, code: 'invalid' })
  })
})

describe('quota (A195 non-negotiable): a write through the folder handle is charged the same way fs.writeFile/FileHandle.write already are', () => {
  it('a write that would exceed the declared quota crosses as \'limit\', not swallowed or altered', async () => {
    const dir = fakeDir({
      writeFile: vi.fn(async () => { throw fail('limit', "this write would exceed the app's declared storage quota") })
    })
    const transport = fsTransport()
    transport.dirRegistry?.register(APP, 'dir-1', dir)

    const response = await handleControlRequest(
      dummyBroker(), frameFor(APP), envelope('fs.dirWriteFile', { id: 'dir-1', path: 'big.bin', data: new Uint8Array(10) }),
      undefined, undefined, undefined, transport
    )

    expect(response).toMatchObject({ ok: false, code: 'limit' })
  })
})

describe('revocation survives the new plumbing (A195) -- both halves handle-contracts.md\'s "FileHandle" section specifies', () => {
  it('revoking the standing fs grant never touches this handle\'s dispatch registration -- no onUnlink fires, the folder stays live', async () => {
    const dir = fakeDir()
    const transport = fsTransport()
    transport.dirRegistry?.register(APP, 'dir-1', dir)

    // Models an ordinary fs-grant revoke: handle-contracts.ts's own
    // Authorisation doc is explicit that a userSelected pick is not part of
    // any grant's set, so nothing calls this handle's onUnlink -- proven
    // here by simply never calling it and confirming the entry still
    // answers. The broker-level guarantee that revoking `fs` really never
    // fires it is src/broker/tests/user-selected.test.ts's own proof
    // ("revoking the standing fs grant does NOT close a picked handle").
    const response = await handleControlRequest(
      dummyBroker(), frameFor(APP), envelope('fs.dirReaddir', { id: 'dir-1' }),
      undefined, undefined, undefined, transport
    )

    expect(response).toMatchObject({ ok: true })
  })

  it('revoking the picked path tears down BOTH the directory handle and a FileHandle opened through it -- they share the folder\'s pickId', async () => {
    let dirUnlink: (() => void) | undefined
    let fileUnlink: (() => void) | undefined
    const openedFile = fakeFile({
      id: 'file-from-dir',
      onUnlink: vi.fn((listener) => { fileUnlink = listener })
    })
    const dir = fakeDir({
      id: 'dir-1',
      onUnlink: vi.fn((listener) => { dirUnlink = listener }),
      open: vi.fn(async () => openedFile)
    })
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { userSelected: async () => dir })
    const transport = fsTransport()

    await handleControlRequest(
      broker, frameFor(APP), envelope('fs.userSelected', { directory: true }),
      undefined, undefined, undefined, transport
    )
    await handleControlRequest(
      broker, frameFor(APP), envelope('fs.dirOpen', { id: 'dir-1', path: 'piece.bin', flags: 'w+' }),
      undefined, undefined, undefined, transport
    )
    expect(transport.dirRegistry?.get(APP, 'dir-1')).toBe(dir)
    expect(transport.registry.get(APP, 'file-from-dir')).toBe(openedFile)

    // Revoking the pick, in production, walks every handle sharing its
    // pickId and unlinks each -- ../user-selected-capability.ts's own
    // `open` acquires the file under `entry.authorisedBy`, THE SAME
    // Authorisation the directory itself carries, which is what makes both
    // fire here. Simulated directly, matching this file's own header on why
    // that is the right level for THIS layer's own proof.
    dirUnlink?.()
    fileUnlink?.()

    expect(transport.dirRegistry?.get(APP, 'dir-1')).toBeUndefined()
    expect(transport.registry.get(APP, 'file-from-dir')).toBeUndefined()

    const dirResponse = await handleControlRequest(
      dummyBroker(), frameFor(APP), envelope('fs.dirReaddir', { id: 'dir-1' }),
      undefined, undefined, undefined, transport
    )
    const fileResponse = await handleControlRequest(
      dummyBroker(), frameFor(APP), envelope('fs.read', { id: 'file-from-dir', position: 0, length: 1 }),
      undefined, undefined, undefined, transport
    )
    expect(dirResponse).toMatchObject({ ok: false, code: 'denied' })
    expect(fileResponse).toMatchObject({ ok: false, code: 'denied' })
  })
})

/** A Broker double whose fs/net/id/app methods are never expected to be called by a test in this file -- every scenario here pre-registers its own fake handle directly, matching ipc-fs-open.test.ts's own cross-origin tests. */
function dummyBroker (): ReturnType<typeof stubBroker> {
  return stubBroker([])
}
