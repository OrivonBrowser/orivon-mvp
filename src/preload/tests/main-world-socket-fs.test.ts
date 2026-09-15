import { describe, expect, it } from 'vitest'
import { installOrivon } from '../main-world-socket.js'
import type { MainWorldFileBridge } from '../main-world-socket.js'
import { LIMITS, fakeBridge, fakeFileBridgeResult, fakeSocketBridgeResult } from './main-world-socket.test-helpers.js'

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
