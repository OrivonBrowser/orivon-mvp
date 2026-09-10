// Exercises node-fs.ts's own wiring -- the module-map target a real
// `import 'fs'` resolves to -- by stubbing globalThis.orivon.fs the way a
// real preload's contextBridge surface would install it. Same pattern as
// node-net.test.ts/node-dgram.test.ts.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Orivon } from '../../contracts/capability-api.js'
import type { FileStat } from '../../contracts/handles.js'

type GlobalWithOrivon = typeof globalThis & { orivon?: Orivon }

function orivonError (code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

function installFakeOrivon (): {
  files: Map<string, Uint8Array>
  stats: Map<string, FileStat>
  mkdirCalls: Array<{ path: string, opts: unknown }>
  rmCalls: Array<{ path: string, opts: unknown }>
  renameCalls: Array<{ from: string, to: string }>
} {
  const files = new Map<string, Uint8Array>()
  const stats = new Map<string, FileStat>()
  const mkdirCalls: Array<{ path: string, opts: unknown }> = []
  const rmCalls: Array<{ path: string, opts: unknown }> = []
  const renameCalls: Array<{ from: string, to: string }> = []

  ;(globalThis as GlobalWithOrivon).orivon = {
    fs: {
      readFile: async (path: string) => {
        const data = files.get(path)
        if (data === undefined) throw orivonError('notFound', 'no such file')
        return data
      },
      writeFile: async (path: string, data: Uint8Array) => { files.set(path, data) },
      readFileSync: (path: string) => {
        const data = files.get(path)
        if (data === undefined) throw orivonError('notFound', 'no such file')
        return data
      },
      mkdir: async (path: string, opts: unknown) => { mkdirCalls.push({ path, opts }) },
      readdir: async (path: string) => (path === '/torrents' ? ['a.bin', 'b.bin'] : []),
      stat: async (path: string) => {
        const stat = stats.get(path)
        if (stat === undefined) throw orivonError('notFound', 'no such file')
        return stat
      },
      rm: async (path: string, opts: unknown) => { rmCalls.push({ path, opts }) },
      rename: async (from: string, to: string) => { renameCalls.push({ from, to }) },
      userSelected: async () => { throw new Error('not used in this test') },
      open: async () => { throw new Error('not used in this test') }
    }
  } as unknown as Orivon

  return { files, stats, mkdirCalls, rmCalls, renameCalls }
}

afterEach(() => {
  delete (globalThis as GlobalWithOrivon).orivon
  vi.resetModules()
})

describe('fs.readFile / fs.writeFile', () => {
  it('writeFile then readFile round-trips bytes, returned as a real Buffer by default', async () => {
    const { files } = installFakeOrivon()
    const fs = await import('../node-fs.js')
    await new Promise<void>((resolve, reject) => {
      fs.writeFile('/piece-0', new Uint8Array([1, 2, 3]), (err) => (err !== null ? reject(err) : resolve()))
    })
    expect(files.get('/piece-0')).toEqual(new Uint8Array([1, 2, 3]))

    const data = await new Promise<Buffer>((resolve, reject) => {
      fs.readFile('/piece-0', (err, result) => (err !== null ? reject(err) : resolve(result as Buffer)))
    })
    expect(Buffer.isBuffer(data)).toBe(true)
    expect([...data]).toEqual([1, 2, 3])
  })

  it('readFile decodes to a string when an encoding is requested -- orivon.fs itself is byte-only', async () => {
    installFakeOrivon()
    const fs = await import('../node-fs.js')
    await new Promise<void>((resolve, reject) => {
      fs.writeFile('/config.json', '{"ok":true}', (err) => (err !== null ? reject(err) : resolve()))
    })
    const text = await new Promise<string>((resolve, reject) => {
      fs.readFile('/config.json', 'utf8', (err, result) => (err !== null ? reject(err) : resolve(result as string)))
    })
    expect(text).toBe('{"ok":true}')
  })

  it('a notFound failure maps to a Node-shaped error, not a raw OrivonError', async () => {
    installFakeOrivon()
    const fs = await import('../node-fs.js')
    const error = await new Promise<Error & { code?: string }>((resolve) => {
      fs.readFile('/missing', (err) => resolve(err as Error & { code?: string }))
    })
    expect(error.code).toBe('notFound')
  })
})

describe('fs.readFileSync', () => {
  it('is the one real synchronous call (ADR-0016)', async () => {
    const { files } = installFakeOrivon()
    files.set('/config', new TextEncoder().encode('hello'))
    const fs = await import('../node-fs.js')
    expect(fs.readFileSync('/config', 'utf8')).toBe('hello')
  })
})

describe('every other synchronous export', () => {
  it('throws a named ADR-0016 error rather than faking a sync capability the broker does not have', async () => {
    installFakeOrivon()
    const fs = await import('../node-fs.js')
    expect(() => fs.statSync('/tmp')).toThrow(/ADR-0016/)
    expect(() => fs.mkdirSync('/x')).toThrow(/ADR-0016/)
    expect(() => fs.writeFileSync('/x', 'y')).toThrow(/ADR-0016/)
    expect(() => fs.existsSync('/x')).toThrow(/ADR-0016/)
  })
})

describe('fs.open', () => {
  it('throws a named error -- no FileHandle capability exists at the broker', async () => {
    installFakeOrivon()
    const fs = await import('../node-fs.js')
    expect(() => fs.open('/x', 'r')).toThrow(/FileHandle/)
  })
})

describe('mkdir / readdir / stat / rm / rename', () => {
  it('mkdir forwards {recursive} through to orivon.fs.mkdir -- fs-chunk-store\'s real call shape', async () => {
    const { mkdirCalls } = installFakeOrivon()
    const fs = await import('../node-fs.js')
    await new Promise<void>((resolve, reject) => {
      fs.mkdir('/torrents/abc', { recursive: true }, (err) => (err !== null ? reject(err) : resolve()))
    })
    expect(mkdirCalls).toEqual([{ path: '/torrents/abc', opts: { recursive: true } }])
  })

  it('readdir returns the entry list', async () => {
    installFakeOrivon()
    const fs = await import('../node-fs.js')
    const entries = await new Promise<readonly string[]>((resolve, reject) => {
      fs.readdir('/torrents', (err, result) => (err !== null ? reject(err) : resolve(result as readonly string[])))
    })
    expect(entries).toEqual(['a.bin', 'b.bin'])
  })

  it('stat wraps the flat FileStat into Node-shaped Stats with real methods', async () => {
    const { stats } = installFakeOrivon()
    stats.set('/piece-0', { size: 10, isFile: true, isDirectory: false, mtimeMs: 1000 })
    const fs = await import('../node-fs.js')
    const stat = await new Promise<import('../node-fs-stats.js').NodeStats>((resolve, reject) => {
      fs.stat('/piece-0', (err, result) => (err !== null ? reject(err) : resolve(result as import('../node-fs-stats.js').NodeStats)))
    })
    expect(stat.isFile()).toBe(true)
    expect(stat.mtime.getTime()).toBe(1000)
  })

  it('rm forwards {recursive}', async () => {
    const { rmCalls } = installFakeOrivon()
    const fs = await import('../node-fs.js')
    await new Promise<void>((resolve, reject) => {
      fs.rm('/torrents/abc', { recursive: true }, (err) => (err !== null ? reject(err) : resolve()))
    })
    expect(rmCalls).toEqual([{ path: '/torrents/abc', opts: { recursive: true } }])
  })

  it('rename forwards both paths', async () => {
    const { renameCalls } = installFakeOrivon()
    const fs = await import('../node-fs.js')
    await new Promise<void>((resolve, reject) => {
      fs.rename('/tmp/x', '/torrents/x', (err) => (err !== null ? reject(err) : resolve()))
    })
    expect(renameCalls).toEqual([{ from: '/tmp/x', to: '/torrents/x' }])
  })
})
