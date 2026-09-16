import { describe, expect, it } from 'vitest'
import { installOrivon } from '../main-world-socket.js'
import type { MainWorldDirectoryBridge, MainWorldFileBridge } from '../main-world-socket.js'
import { LIMITS, fakeBridge, fakeDirectoryBridgeResult, fakeFileBridgeResult, fakeSocketBridgeResult } from './main-world-socket.test-helpers.js'

// orivon.fs.open (A184) -- split out of main-world-socket.test.ts under
// code-guidelines.md's 800-line test limit, matching main-world-socket-udp.
// test.ts's own precedent for a concern with no TCP-socket dependency.
//
// buildFile (main-world-socket.ts) is deliberately simple: no port, no
// stream, just callRevived wrapped around each of fs.open's returned
// closures -- this file proves that wrapping actually happens for EVERY
// one of them, not only the ones a hand-written smoke test happens to call.

function fsOrivon (target: Record<string, unknown>): { open: (path: string, flags: string) => Promise<MainWorldFileBridge> } {
  return (target.orivon as { fs: { open: (path: string, flags: string) => Promise<MainWorldFileBridge> } }).fs
}

describe('orivon.fs.open', () => {
  it('passes path and flags through to bridge.fsOpen and returns a handle carrying its id', async () => {
    const target: Record<string, unknown> = {}
    const calls: Array<{ path: string, flags: string }> = []
    const bridge = fakeBridge(fakeSocketBridgeResult())
    bridge.fsOpen = async (path, flags) => { calls.push({ path, flags }); return fakeFileBridgeResult({ id: 'xyz' }) }
    installOrivon(bridge, LIMITS, target)

    const file = await fsOrivon(target).open('piece.bin', 'w+')

    expect(calls).toEqual([{ path: 'piece.bin', flags: 'w+' }])
    expect(file.id).toBe('xyz')
  })

  it('read/write/stat/truncate/sync/close all forward their arguments to the matching bridge closure', async () => {
    const target: Record<string, unknown> = {}
    const seen: Record<string, unknown> = {}
    const bridge = fakeBridge(fakeSocketBridgeResult())
    bridge.fsOpen = async () => ({
      id: 'h1',
      read: async (opts) => { seen.read = opts; return new Uint8Array([1, 2]) },
      write: async (opts) => { seen.write = opts; return 2 },
      stat: async () => { seen.stat = true; return { size: 2, isFile: true, isDirectory: false, mtimeMs: 5 } },
      truncate: async (length) => { seen.truncate = length },
      sync: async () => { seen.sync = true },
      close: async () => { seen.close = true }
    })
    installOrivon(bridge, LIMITS, target)
    const file = await fsOrivon(target).open('a', 'w+')

    const readBack = await file.read({ position: 4, length: 2 })
    const written = await file.write({ position: 0, data: new Uint8Array([9]) })
    const stat = await file.stat()
    await file.truncate(10)
    await file.sync()
    await file.close()

    expect(Array.from(readBack)).toEqual([1, 2])
    expect(seen.read).toEqual({ position: 4, length: 2 })
    expect(written).toBe(2)
    expect(seen.write).toEqual({ position: 0, data: new Uint8Array([9]) })
    expect(stat).toEqual({ size: 2, isFile: true, isDirectory: false, mtimeMs: 5 })
    expect(seen.truncate).toBe(10)
    expect(seen.sync).toBe(true)
    expect(seen.close).toBe(true)
  })

  // A152, applied to fs.open's own nested closures -- the same revival
  // main-world-socket.test.ts already proves for net.connect. Each of
  // read/write/stat/truncate/sync/close crosses back into the isolated
  // world independently, so each needs its OWN callRevived, not just the
  // outer fs.open call.
  it('A152: revives a rejection from a NESTED fs.open closure (not just the outer open() call)', async () => {
    const target: Record<string, unknown> = {}
    const bridge = fakeBridge(fakeSocketBridgeResult())
    bridge.fsOpen = async () => fakeFileBridgeResult({
      read: async () => { throw { name: 'OrivonError', message: 'the grant authorising this fs operation was withdrawn', code: 'revoked' } }
    })
    installOrivon(bridge, LIMITS, target)
    const file = await fsOrivon(target).open('a', 'r')

    let caught: unknown
    try {
      await file.read({ position: 0, length: 1 })
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as { code?: string }).code).toBe('revoked')
  })

  it('the outer fs.open() call itself is revived the same way (a denied grant, for example)', async () => {
    const target: Record<string, unknown> = {}
    const bridge = fakeBridge(fakeSocketBridgeResult())
    bridge.fsOpen = async () => { throw { name: 'OrivonError', message: 'fs is not granted to this origin', code: 'denied' } }
    installOrivon(bridge, LIMITS, target)

    let caught: unknown
    try {
      await fsOrivon(target).open('a', 'r')
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as { code?: string }).code).toBe('denied')
  })

  it('orivon.fs.open is a function on the built window.orivon object', () => {
    const target: Record<string, unknown> = {}
    installOrivon(fakeBridge(fakeSocketBridgeResult()), LIMITS, target)

    const orivon = target.orivon as Record<string, unknown>
    expect(typeof (orivon.fs as Record<string, unknown>).open).toBe('function')
  })
})

function fsUserSelectedOrivon (target: Record<string, unknown>): { userSelected: (opts?: { multiple?: boolean }) => Promise<readonly MainWorldFileBridge[]> } {
  return (target.orivon as { fs: { userSelected: (opts?: { multiple?: boolean }) => Promise<readonly MainWorldFileBridge[]> } }).fs
}

// orivon.fs.userSelected (A194, d-0032) -- the FILE shape only. `buildFile`
// itself is already proven above for every nested closure; this suite
// proves the array-wrapping `userSelected` adds on top: opts passed
// through, one MainWorldFileBridge per returned raw result, in order, and
// that each is independently revived (A152) the same way a single fs.open
// result already is.
describe('orivon.fs.userSelected', () => {
  it('passes opts through to bridge.fsUserSelected and wraps every returned result', async () => {
    const target: Record<string, unknown> = {}
    const calls: Array<{ multiple?: boolean } | undefined> = []
    const bridge = fakeBridge(fakeSocketBridgeResult())
    bridge.fsUserSelected = async (opts) => {
      calls.push(opts)
      return [fakeFileBridgeResult({ id: 'p1' }), fakeFileBridgeResult({ id: 'p2' })]
    }
    installOrivon(bridge, LIMITS, target)

    const files = await fsUserSelectedOrivon(target).userSelected({ multiple: true })

    expect(calls).toEqual([{ multiple: true }])
    expect(files.map((f) => f.id)).toEqual(['p1', 'p2'])
  })

  it('a cancelled picker resolves an empty array, never a rejection', async () => {
    const target: Record<string, unknown> = {}
    const bridge = fakeBridge(fakeSocketBridgeResult())
    bridge.fsUserSelected = async () => []
    installOrivon(bridge, LIMITS, target)

    await expect(fsUserSelectedOrivon(target).userSelected()).resolves.toEqual([])
  })

  it('each wrapped result is independently usable -- read/close forward to that ONE result\'s own closures, not a shared one', async () => {
    const target: Record<string, unknown> = {}
    const bridge = fakeBridge(fakeSocketBridgeResult())
    const seen: Array<{ id: string, op: string }> = []
    bridge.fsUserSelected = async () => [
      { id: 'p1', read: async () => { seen.push({ id: 'p1', op: 'read' }); return new Uint8Array([1]) }, write: async () => 0, stat: async () => ({ size: 0, isFile: true, isDirectory: false, mtimeMs: 0 }), truncate: async () => {}, sync: async () => {}, close: async () => { seen.push({ id: 'p1', op: 'close' }) } },
      { id: 'p2', read: async () => { seen.push({ id: 'p2', op: 'read' }); return new Uint8Array([2]) }, write: async () => 0, stat: async () => ({ size: 0, isFile: true, isDirectory: false, mtimeMs: 0 }), truncate: async () => {}, sync: async () => {}, close: async () => { seen.push({ id: 'p2', op: 'close' }) } }
    ]
    installOrivon(bridge, LIMITS, target)

    const [first, second] = await fsUserSelectedOrivon(target).userSelected({ multiple: true })
    await second?.read({ position: 0, length: 1 })
    await first?.close()

    expect(seen).toEqual([{ id: 'p2', op: 'read' }, { id: 'p1', op: 'close' }])
  })

  // A152, applied here the same way main-world-socket-fs.test.ts's own
  // fs.open suite already proves it for a single handle -- a rejection from
  // bridge.fsUserSelected ITSELF (the outer call, e.g. a denied grant) must
  // still cross as a real revived error, not a raw thrown value.
  it('A152: revives a rejection from the outer bridge.fsUserSelected call', async () => {
    const target: Record<string, unknown> = {}
    const bridge = fakeBridge(fakeSocketBridgeResult())
    bridge.fsUserSelected = async () => { throw { name: 'OrivonError', message: 'the OS picker could not be shown', code: 'internal' } }
    installOrivon(bridge, LIMITS, target)

    let caught: unknown
    try {
      await fsUserSelectedOrivon(target).userSelected()
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as { code?: string }).code).toBe('internal')
  })
})

function fsUserSelectedDirOrivon (target: Record<string, unknown>): {
  userSelected: (opts: { directory: true }) => Promise<MainWorldDirectoryBridge | null>
} {
  return (target.orivon as { fs: { userSelected: (opts: { directory: true }) => Promise<MainWorldDirectoryBridge | null> } }).fs
}

// orivon.fs.userSelected -- the FOLDER shape (A195, closing A194).
// `buildDirectory` (main-world-socket.ts) is `buildFile`'s own counterpart:
// this suite proves it wraps every nested closure, that `open` reuses
// `buildFile` on whatever it resolves (no second file-handle mechanism),
// and that both the outer call and each nested closure revive a rejection
// independently (A152), matching fs.open's own suite above.
describe('orivon.fs.userSelected -- the folder shape', () => {
  it('calls bridge.fsUserSelectedDirectory and wraps the result into a directory handle', async () => {
    const target: Record<string, unknown> = {}
    const bridge = fakeBridge(fakeSocketBridgeResult())
    bridge.fsUserSelectedDirectory = async () => fakeDirectoryBridgeResult({ id: 'dir-1' })
    installOrivon(bridge, LIMITS, target)

    const dir = await fsUserSelectedDirOrivon(target).userSelected({ directory: true })

    expect(dir?.id).toBe('dir-1')
  })

  it('a cancelled folder pick resolves null, never a rejection', async () => {
    const target: Record<string, unknown> = {}
    const bridge = fakeBridge(fakeSocketBridgeResult())
    bridge.fsUserSelectedDirectory = async () => null
    installOrivon(bridge, LIMITS, target)

    await expect(fsUserSelectedDirOrivon(target).userSelected({ directory: true })).resolves.toBeNull()
  })

  it('readdir/stat/mkdir/rm/rename/readFile/writeFile/close all forward their arguments to the matching bridge closure', async () => {
    const target: Record<string, unknown> = {}
    const seen: Record<string, unknown> = {}
    const bridge = fakeBridge(fakeSocketBridgeResult())
    bridge.fsUserSelectedDirectory = async () => ({
      id: 'dir-1',
      readdir: async (path) => { seen.readdir = path; return ['a.txt'] },
      stat: async (path) => { seen.stat = path; return { size: 0, isFile: false, isDirectory: true, mtimeMs: 0 } },
      mkdir: async (path, opts) => { seen.mkdir = { path, opts } },
      rm: async (path, opts) => { seen.rm = { path, opts } },
      rename: async (from, to) => { seen.rename = { from, to } },
      readFile: async (path) => { seen.readFile = path; return new Uint8Array([7]) },
      writeFile: async (path, data) => { seen.writeFile = { path, data } },
      open: async () => fakeFileBridgeResult(),
      close: async () => { seen.close = true }
    })
    installOrivon(bridge, LIMITS, target)
    const dir = await fsUserSelectedDirOrivon(target).userSelected({ directory: true })

    const entries = await dir?.readdir('sub')
    const stat = await dir?.stat('sub')
    await dir?.mkdir('sub', { recursive: true })
    await dir?.rm('sub', { recursive: true })
    await dir?.rename('a.txt', 'b.txt')
    const bytes = await dir?.readFile('a.txt')
    await dir?.writeFile('a.txt', new Uint8Array([1]))
    await dir?.close()

    expect(entries).toEqual(['a.txt'])
    expect(seen.readdir).toBe('sub')
    expect(stat).toEqual({ size: 0, isFile: false, isDirectory: true, mtimeMs: 0 })
    expect(seen.mkdir).toEqual({ path: 'sub', opts: { recursive: true } })
    expect(seen.rm).toEqual({ path: 'sub', opts: { recursive: true } })
    expect(seen.rename).toEqual({ from: 'a.txt', to: 'b.txt' })
    expect(Array.from(bytes ?? [])).toEqual([7])
    expect(seen.writeFile).toEqual({ path: 'a.txt', data: new Uint8Array([1]) })
    expect(seen.close).toBe(true)
  })

  it('open() reuses buildFile on whatever it resolves -- the returned handle works through the SAME nested closures fs.open\'s own does', async () => {
    const target: Record<string, unknown> = {}
    const bridge = fakeBridge(fakeSocketBridgeResult())
    bridge.fsUserSelectedDirectory = async () => fakeDirectoryBridgeResult({
      open: async () => fakeFileBridgeResult({ id: 'file-1', read: async () => new Uint8Array([42]) })
    })
    installOrivon(bridge, LIMITS, target)
    const dir = await fsUserSelectedDirOrivon(target).userSelected({ directory: true })

    const file = await dir?.open('piece.bin', 'w+')

    expect(file?.id).toBe('file-1')
    expect(Array.from(await file?.read({ position: 0, length: 1 }) ?? [])).toEqual([42])
  })

  it('A152: revives a rejection from a NESTED closure (not just the outer userSelected call)', async () => {
    const target: Record<string, unknown> = {}
    const bridge = fakeBridge(fakeSocketBridgeResult())
    bridge.fsUserSelectedDirectory = async () => fakeDirectoryBridgeResult({
      readdir: async () => { throw { name: 'OrivonError', message: 'the path is outside the picked folder', code: 'denied' } }
    })
    installOrivon(bridge, LIMITS, target)
    const dir = await fsUserSelectedDirOrivon(target).userSelected({ directory: true })

    let caught: unknown
    try {
      await dir?.readdir('../escape')
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as { code?: string }).code).toBe('denied')
  })

  it('the outer bridge.fsUserSelectedDirectory call itself is revived the same way', async () => {
    const target: Record<string, unknown> = {}
    const bridge = fakeBridge(fakeSocketBridgeResult())
    bridge.fsUserSelectedDirectory = async () => { throw { name: 'OrivonError', message: 'the OS picker could not be shown', code: 'internal' } }
    installOrivon(bridge, LIMITS, target)

    let caught: unknown
    try {
      await fsUserSelectedDirOrivon(target).userSelected({ directory: true })
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as { code?: string }).code).toBe('internal')
  })
})
