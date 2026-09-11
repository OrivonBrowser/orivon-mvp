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

// hex/base64/base64url are Node's binary-to-text encodings, not character
// sets TextDecoder understands -- readFile('x', 'hex', cb) threw RangeError
// before this fix, in place of ever calling back with data.
describe('fs.readFile -- binary-to-text encodings', () => {
  it('decodes hex', async () => {
    const { files } = installFakeOrivon()
    files.set('/x', new Uint8Array([0xde, 0xad, 0xbe, 0xef]))
    const fs = await import('../node-fs.js')
    const text = await new Promise<string>((resolve, reject) => {
      fs.readFile('/x', 'hex', (err, result) => (err !== null ? reject(err) : resolve(result as string)))
    })
    expect(text).toBe('deadbeef')
  })

  it('decodes base64', async () => {
    const { files } = installFakeOrivon()
    files.set('/x', new TextEncoder().encode('hello'))
    const fs = await import('../node-fs.js')
    const text = await new Promise<string>((resolve, reject) => {
      fs.readFile('/x', 'base64', (err, result) => (err !== null ? reject(err) : resolve(result as string)))
    })
    expect(text).toBe('aGVsbG8=')
  })

  it('decodes base64url', async () => {
    const { files } = installFakeOrivon()
    files.set('/x', new TextEncoder().encode('hello'))
    const fs = await import('../node-fs.js')
    const text = await new Promise<string>((resolve, reject) => {
      fs.readFile('/x', 'base64url', (err, result) => (err !== null ? reject(err) : resolve(result as string)))
    })
    expect(text).toBe('aGVsbG8')
  })
})

// Before this fix, writeFile's overload accepted an `options` argument but
// never read it back out of splitTail's result -- every string write landed
// as UTF-8 regardless of what the caller asked for, corrupting hex/base64
// payloads silently (no error, just wrong bytes on disk).
describe('fs.writeFile -- respects options.encoding', () => {
  it('writes hex-encoded string data as the decoded bytes, not its literal UTF-8 text', async () => {
    const { files } = installFakeOrivon()
    const fs = await import('../node-fs.js')
    await new Promise<void>((resolve, reject) => {
      fs.writeFile('/x', 'deadbeef', { encoding: 'hex' }, (err) => (err !== null ? reject(err) : resolve()))
    })
    // Compared as a plain byte array, not via toEqual against a literal
    // Uint8Array: encode() returns a `buffer`-package Buffer, whose own
    // toJSON() makes vitest's structural equality see a mismatched shape
    // even though the underlying bytes are identical.
    expect([...(files.get('/x') ?? [])]).toEqual([0xde, 0xad, 0xbe, 0xef])
  })

  it('accepts the encoding-as-string shorthand, matching readFile\'s own overload', async () => {
    const { files } = installFakeOrivon()
    const fs = await import('../node-fs.js')
    await new Promise<void>((resolve, reject) => {
      fs.writeFile('/x', 'aGVsbG8=', 'base64', (err) => (err !== null ? reject(err) : resolve()))
    })
    expect([...(files.get('/x') ?? [])]).toEqual([...new TextEncoder().encode('hello')])
  })
})

// A user callback that throws must be called exactly once, matching real
// Node. Before this fix, every wrapper chained `.then(cb).catch(...)`, so a
// throw INSIDE the .then() handler (i.e. inside the user's own callback) was
// caught by the trailing .catch() and re-delivered to the same callback a
// second time, now wrapped as an error.
describe('fs.* -- a throwing callback is invoked exactly once', () => {
  async function countCallsWhenCallbackThrows (run: (cb: (err: Error | null, ...rest: readonly unknown[]) => void) => void): Promise<number> {
    let calls = 0
    // The throw is expected to escape as an unhandled rejection now that it
    // is no longer swallowed by a `.catch()` -- matching real Node, where an
    // exception escaping an I/O completion callback is never re-delivered.
    // Silenced here (socket-port.test.ts's P-F9 uses the same pattern) so
    // this test's own deliberate throw does not fail the run; the assertion
    // below is what actually proves the fix.
    const onUnhandled = (): void => {}
    process.on('unhandledRejection', onUnhandled)
    try {
      run(() => { calls++; throw new Error('user callback blew up') })
      await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    return calls
  }

  it('readFile', async () => {
    const { files } = installFakeOrivon()
    files.set('/x', new Uint8Array([1]))
    const fs = await import('../node-fs.js')
    expect(await countCallsWhenCallbackThrows((cb) => fs.readFile('/x', cb))).toBe(1)
  })

  it('writeFile', async () => {
    installFakeOrivon()
    const fs = await import('../node-fs.js')
    expect(await countCallsWhenCallbackThrows((cb) => fs.writeFile('/x', 'data', cb))).toBe(1)
  })

  it('mkdir', async () => {
    installFakeOrivon()
    const fs = await import('../node-fs.js')
    expect(await countCallsWhenCallbackThrows((cb) => fs.mkdir('/x', cb))).toBe(1)
  })

  it('readdir', async () => {
    installFakeOrivon()
    const fs = await import('../node-fs.js')
    expect(await countCallsWhenCallbackThrows((cb) => fs.readdir('/torrents', cb))).toBe(1)
  })

  it('stat', async () => {
    const { stats } = installFakeOrivon()
    stats.set('/x', { size: 1, isFile: true, isDirectory: false, mtimeMs: 0 })
    const fs = await import('../node-fs.js')
    expect(await countCallsWhenCallbackThrows((cb) => fs.stat('/x', cb))).toBe(1)
  })

  it('rm', async () => {
    installFakeOrivon()
    const fs = await import('../node-fs.js')
    expect(await countCallsWhenCallbackThrows((cb) => fs.rm('/x', cb))).toBe(1)
  })

  it('rename', async () => {
    installFakeOrivon()
    const fs = await import('../node-fs.js')
    expect(await countCallsWhenCallbackThrows((cb) => fs.rename('/a', '/b', cb))).toBe(1)
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
