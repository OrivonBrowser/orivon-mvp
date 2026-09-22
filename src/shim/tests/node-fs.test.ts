// Exercises node-fs.ts's own wiring -- the module-map target a real
// `import 'fs'` resolves to -- by stubbing globalThis.orivon.fs the way a
// real preload's contextBridge surface would install it. Same pattern as
// node-net.test.ts/node-dgram.test.ts.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Orivon } from '../../contracts/capability-api.js'
import type { FileStat } from '../../contracts/handles.js'
import { createFakeFileHandle } from './support/fake-file-handle.js'
import { PageBuffer } from './support/page-buffer.js'

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
  openCalls: Array<{ path: string, flags: string }>
} {
  const files = new Map<string, Uint8Array>()
  const stats = new Map<string, FileStat>()
  const mkdirCalls: Array<{ path: string, opts: unknown }> = []
  const rmCalls: Array<{ path: string, opts: unknown }> = []
  const renameCalls: Array<{ from: string, to: string }> = []
  const openCalls: Array<{ path: string, flags: string }> = []

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
      readdir: async (path: string) => (path === 'torrents' ? ['a.bin', 'b.bin'] : []),
      stat: async (path: string) => {
        const stat = stats.get(path)
        if (stat === undefined) throw orivonError('notFound', 'no such file')
        return stat
      },
      rm: async (path: string, opts: unknown) => { rmCalls.push({ path, opts }) },
      rename: async (from: string, to: string) => { renameCalls.push({ from, to }) },
      userSelected: async () => { throw new Error('not used in this test') },
      // fs.open's own cursor/callback-family behaviour is
      // node-fs-handle.test.ts's job; this stub only proves node-fs.ts's
      // re-export ROUTES to it correctly. Seeded from `files` (so an
      // append-mode open's initialCursor() sees the real current size) and
      // every write mirrored back into `files`, so appendFile's round trip
      // is observable through the same map readFile/writeFile already use.
      open: async (path: string, flags: string) => {
        openCalls.push({ path, flags })
        const fake = createFakeFileHandle(files.get(path) ?? new Uint8Array(0))
        const write = fake.handle.write.bind(fake.handle)
        fake.handle.write = async (opts) => {
          const written = await write(opts)
          files.set(path, fake.bytes())
          return written
        }
        return fake.handle
      }
    }
  } as unknown as Orivon

  return { files, stats, mkdirCalls, rmCalls, renameCalls, openCalls }
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
      fs.writeFile('piece-0', new Uint8Array([1, 2, 3]), (err) => (err !== null ? reject(err) : resolve()))
    })
    expect(files.get('piece-0')).toEqual(new Uint8Array([1, 2, 3]))

    const data = await new Promise<Buffer>((resolve, reject) => {
      fs.readFile('piece-0', (err, result) => (err !== null ? reject(err) : resolve(result as Buffer)))
    })
    expect(PageBuffer.isBuffer(data)).toBe(true)
    expect([...data]).toEqual([1, 2, 3])
  })

  it('readFile decodes to a string when an encoding is requested -- orivon.fs itself is byte-only', async () => {
    installFakeOrivon()
    const fs = await import('../node-fs.js')
    await new Promise<void>((resolve, reject) => {
      fs.writeFile('config.json', '{"ok":true}', (err) => (err !== null ? reject(err) : resolve()))
    })
    const text = await new Promise<string>((resolve, reject) => {
      fs.readFile('config.json', 'utf8', (err, result) => (err !== null ? reject(err) : resolve(result as string)))
    })
    expect(text).toBe('{"ok":true}')
  })

  it('a notFound failure maps to a Node-shaped error, not a raw OrivonError', async () => {
    installFakeOrivon()
    const fs = await import('../node-fs.js')
    const error = await new Promise<Error & { code?: string }>((resolve) => {
      fs.readFile('missing', (err) => resolve(err as Error & { code?: string }))
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
    files.set('x', new Uint8Array([0xde, 0xad, 0xbe, 0xef]))
    const fs = await import('../node-fs.js')
    const text = await new Promise<string>((resolve, reject) => {
      fs.readFile('x', 'hex', (err, result) => (err !== null ? reject(err) : resolve(result as string)))
    })
    expect(text).toBe('deadbeef')
  })

  it('decodes base64', async () => {
    const { files } = installFakeOrivon()
    files.set('x', new TextEncoder().encode('hello'))
    const fs = await import('../node-fs.js')
    const text = await new Promise<string>((resolve, reject) => {
      fs.readFile('x', 'base64', (err, result) => (err !== null ? reject(err) : resolve(result as string)))
    })
    expect(text).toBe('aGVsbG8=')
  })

  it('decodes base64url', async () => {
    const { files } = installFakeOrivon()
    files.set('x', new TextEncoder().encode('hello'))
    const fs = await import('../node-fs.js')
    const text = await new Promise<string>((resolve, reject) => {
      fs.readFile('x', 'base64url', (err, result) => (err !== null ? reject(err) : resolve(result as string)))
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
      fs.writeFile('x', 'deadbeef', { encoding: 'hex' }, (err) => (err !== null ? reject(err) : resolve()))
    })
    // Compared as a plain byte array, not via toEqual against a literal
    // Uint8Array: encode() returns a `buffer`-package Buffer, whose own
    // toJSON() makes vitest's structural equality see a mismatched shape
    // even though the underlying bytes are identical.
    expect([...(files.get('x') ?? [])]).toEqual([0xde, 0xad, 0xbe, 0xef])
  })

  it('accepts the encoding-as-string shorthand, matching readFile\'s own overload', async () => {
    const { files } = installFakeOrivon()
    const fs = await import('../node-fs.js')
    await new Promise<void>((resolve, reject) => {
      fs.writeFile('x', 'aGVsbG8=', 'base64', (err) => (err !== null ? reject(err) : resolve()))
    })
    expect([...(files.get('x') ?? [])]).toEqual([...new TextEncoder().encode('hello')])
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
    files.set('x', new Uint8Array([1]))
    const fs = await import('../node-fs.js')
    expect(await countCallsWhenCallbackThrows((cb) => fs.readFile('x', cb))).toBe(1)
  })

  it('writeFile', async () => {
    installFakeOrivon()
    const fs = await import('../node-fs.js')
    expect(await countCallsWhenCallbackThrows((cb) => fs.writeFile('x', 'data', cb))).toBe(1)
  })

  it('mkdir', async () => {
    installFakeOrivon()
    const fs = await import('../node-fs.js')
    expect(await countCallsWhenCallbackThrows((cb) => fs.mkdir('x', cb))).toBe(1)
  })

  it('readdir', async () => {
    installFakeOrivon()
    const fs = await import('../node-fs.js')
    expect(await countCallsWhenCallbackThrows((cb) => fs.readdir('torrents', cb))).toBe(1)
  })

  it('stat', async () => {
    const { stats } = installFakeOrivon()
    stats.set('x', { size: 1, isFile: true, isDirectory: false, mtimeMs: 0 })
    const fs = await import('../node-fs.js')
    expect(await countCallsWhenCallbackThrows((cb) => fs.stat('x', cb))).toBe(1)
  })

  it('rm', async () => {
    installFakeOrivon()
    const fs = await import('../node-fs.js')
    expect(await countCallsWhenCallbackThrows((cb) => fs.rm('x', cb))).toBe(1)
  })

  it('rename', async () => {
    installFakeOrivon()
    const fs = await import('../node-fs.js')
    expect(await countCallsWhenCallbackThrows((cb) => fs.rename('a', 'b', cb))).toBe(1)
  })
})

describe('fs.readFileSync', () => {
  it('is the one real synchronous call (ADR-0016)', async () => {
    const { files } = installFakeOrivon()
    files.set('config', new TextEncoder().encode('hello'))
    const fs = await import('../node-fs.js')
    expect(fs.readFileSync('config', 'utf8')).toBe('hello')
  })
})

describe('every other synchronous export', () => {
  it('throws a named ADR-0016 error rather than faking a sync capability the broker does not have', async () => {
    installFakeOrivon()
    const fs = await import('../node-fs.js')
    expect(() => fs.statSync('tmp')).toThrow(/ADR-0016/)
    expect(() => fs.mkdirSync('x')).toThrow(/ADR-0016/)
    expect(() => fs.writeFileSync('x', 'y')).toThrow(/ADR-0016/)
    expect(() => fs.accessSync('x')).toThrow(/ADR-0016/)
    expect(() => fs.appendFileSync('x', 'y')).toThrow(/ADR-0016/)
    expect(() => fs.unlinkSync('x')).toThrow(/ADR-0016/)
  })
})

describe('fs.appendFile', () => {
  it('opens with flags \'a\' and writes once -- a real append, not read-modify-write', async () => {
    const { files, openCalls } = installFakeOrivon()
    files.set('log', new TextEncoder().encode('first\n'))
    const fs = await import('../node-fs.js')
    await new Promise<void>((resolve, reject) => {
      fs.appendFile('log', 'second\n', (err) => (err !== null ? reject(err) : resolve()))
    })
    expect(openCalls).toEqual([{ path: 'log', flags: 'a' }])
    expect(new TextDecoder().decode(files.get('log'))).toBe('first\nsecond\n')
  })

  it('creates a new file when none exists yet', async () => {
    const { files } = installFakeOrivon()
    const fs = await import('../node-fs.js')
    await new Promise<void>((resolve, reject) => {
      fs.appendFile('new-log', 'hello', (err) => (err !== null ? reject(err) : resolve()))
    })
    expect(new TextDecoder().decode(files.get('new-log'))).toBe('hello')
  })

  it('respects options.encoding, matching writeFile\'s own overload', async () => {
    const { files } = installFakeOrivon()
    const fs = await import('../node-fs.js')
    await new Promise<void>((resolve, reject) => {
      fs.appendFile('x', 'deadbeef', { encoding: 'hex' }, (err) => (err !== null ? reject(err) : resolve()))
    })
    expect([...(files.get('x') ?? [])]).toEqual([0xde, 0xad, 0xbe, 0xef])
  })
})

describe('fs.access', () => {
  it('resolves when the path exists, regardless of which mode is asked', async () => {
    const { stats } = installFakeOrivon()
    stats.set('x', { size: 1, isFile: true, isDirectory: false, mtimeMs: 0 })
    const fs = await import('../node-fs.js')
    const { constants } = fs.default
    await new Promise<void>((resolve, reject) => {
      fs.access('x', constants.F_OK, (err) => (err !== null ? reject(err) : resolve()))
    })
    await new Promise<void>((resolve, reject) => {
      fs.access('x', constants.R_OK | constants.W_OK, (err) => (err !== null ? reject(err) : resolve()))
    })
  })

  it('a notFound failure maps to a Node-shaped error, matching every other fs call', async () => {
    installFakeOrivon()
    const fs = await import('../node-fs.js')
    const error = await new Promise<Error & { code?: string }>((resolve) => {
      fs.access('missing', (err) => resolve(err as Error & { code?: string }))
    })
    expect(error.code).toBe('notFound')
  })
})

describe('fs.unlink', () => {
  it('rides fs.rm with no options -- real Node\'s unlink never takes one either', async () => {
    const { rmCalls } = installFakeOrivon()
    const fs = await import('../node-fs.js')
    await new Promise<void>((resolve, reject) => {
      fs.unlink('x', (err) => (err !== null ? reject(err) : resolve()))
    })
    expect(rmCalls).toEqual([{ path: 'x', opts: undefined }])
  })
})

describe('fs.constants', () => {
  it('is a real object carrying the four access() modes nedb\'s existsAsync reads (fs.constants.F_OK)', async () => {
    installFakeOrivon()
    const fs = (await import('../node-fs.js')).default
    expect(fs.constants).toEqual({ F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 })
  })

  it('is the SAME object on fs.promises.constants, matching real Node', async () => {
    installFakeOrivon()
    const fs = (await import('../node-fs.js')).default
    expect(fs.promises.constants).toBe(fs.constants)
  })
})

// A relative path like nedb's own 'settings.db' must reach orivon.fs
// completely unchanged -- no leading slash added, no join against a cwd,
// no path.resolve. The broker (never this shim) is what confines it to the
// app's own files directory root (capability-api.ts's OrivonFs doc).
describe('a relative path is passed to orivon.fs verbatim', () => {
  it('readFile / writeFile / mkdir / stat / rm / rename', async () => {
    const { files, mkdirCalls, rmCalls, renameCalls, stats } = installFakeOrivon()
    files.set('settings.db', new Uint8Array([1]))
    stats.set('settings.db', { size: 1, isFile: true, isDirectory: false, mtimeMs: 0 })
    const fs = await import('../node-fs.js')

    await new Promise<void>((resolve, reject) => fs.readFile('settings.db', (err) => (err !== null ? reject(err) : resolve())))
    await new Promise<void>((resolve, reject) => fs.writeFile('settings.db', 'x', (err) => (err !== null ? reject(err) : resolve())))
    // NOT '.' -- a root-resolving path is its own case now, covered by
    // node-fs-root.test.ts; this test's own job is proving an ordinary
    // relative path is untouched, so it uses one that is not the root.
    await new Promise<void>((resolve, reject) => fs.mkdir('settings-dir', (err) => (err !== null ? reject(err) : resolve())))
    await new Promise<void>((resolve, reject) => fs.stat('settings.db', (err) => (err !== null ? reject(err) : resolve())))
    await new Promise<void>((resolve, reject) => fs.rm('settings.db', (err) => (err !== null ? reject(err) : resolve())))
    await new Promise<void>((resolve, reject) => fs.rename('settings.db', 'settings.db~', (err) => (err !== null ? reject(err) : resolve())))

    expect([...files.keys()]).toContain('settings.db')
    expect(mkdirCalls).toEqual([{ path: 'settings-dir', opts: undefined }])
    expect(rmCalls).toEqual([{ path: 'settings.db', opts: undefined }])
    expect(renameCalls).toEqual([{ from: 'settings.db', to: 'settings.db~' }])
  })

  it('fs.open / fs.appendFile', async () => {
    const { openCalls } = installFakeOrivon()
    const fs = await import('../node-fs.js')
    await new Promise<number>((resolve, reject) => {
      fs.open('settings.db', 'r+', (err, fd) => (err !== null ? reject(err) : resolve(fd as number)))
    })
    await new Promise<void>((resolve, reject) => {
      fs.appendFile('settings.db', 'x', (err) => (err !== null ? reject(err) : resolve()))
    })
    expect(openCalls).toEqual([{ path: 'settings.db', flags: 'r+' }, { path: 'settings.db', flags: 'a' }])
  })
})

describe('fs.open / fs.promises.open', () => {
  it('fs.open routes through orivon.fs.open -- node-fs-handle.test.ts covers the cursor/callback behaviour', async () => {
    const { openCalls } = installFakeOrivon()
    const fs = await import('../node-fs.js')
    const fd = await new Promise<number>((resolve, reject) => {
      fs.open('piece-0', 'r+', (err, result) => (err !== null ? reject(err) : resolve(result as number)))
    })
    expect(typeof fd).toBe('number')
    expect(openCalls).toEqual([{ path: 'piece-0', flags: 'r+' }])
  })

  it('fs.promises.open routes through the same orivon.fs.open', async () => {
    const { openCalls } = installFakeOrivon()
    const fs = await import('../node-fs.js')
    const handle = await fs.promises.open('piece-0', 'r+')
    expect(typeof handle.fd).toBe('number')
    expect(openCalls).toEqual([{ path: 'piece-0', flags: 'r+' }])
  })

  // readFile/writeFile/access/appendFile/rename/unlink/mkdir/readdir/stat/rm
  // are all real now (node-fs-promises.test.ts) -- `watch` stands in here as
  // a member still genuinely unbuilt.
  it('fs.promises\'s other members are named, not silently absent (A135) -- reading one is safe (A169), only calling it refuses', async () => {
    installFakeOrivon()
    const fs = await import('../node-fs.js')
    const { OrivonShimError } = await import('../errors.js')
    const promisesRec = fs.promises as unknown as Record<string, () => unknown>
    expect(() => promisesRec.watch).not.toThrow()
    expect(() => promisesRec.watch!()).toThrow(OrivonShimError)
  })
})

describe('mkdir / readdir / stat / rm / rename', () => {
  it('mkdir forwards {recursive} through to orivon.fs.mkdir -- fs-chunk-store\'s real call shape', async () => {
    const { mkdirCalls } = installFakeOrivon()
    const fs = await import('../node-fs.js')
    await new Promise<void>((resolve, reject) => {
      fs.mkdir('torrents/abc', { recursive: true }, (err) => (err !== null ? reject(err) : resolve()))
    })
    expect(mkdirCalls).toEqual([{ path: 'torrents/abc', opts: { recursive: true } }])
  })

  it('readdir returns the entry list', async () => {
    installFakeOrivon()
    const fs = await import('../node-fs.js')
    const entries = await new Promise<readonly string[]>((resolve, reject) => {
      fs.readdir('torrents', (err, result) => (err !== null ? reject(err) : resolve(result as readonly string[])))
    })
    expect(entries).toEqual(['a.bin', 'b.bin'])
  })

  it('stat wraps the flat FileStat into Node-shaped Stats with real methods', async () => {
    const { stats } = installFakeOrivon()
    stats.set('piece-0', { size: 10, isFile: true, isDirectory: false, mtimeMs: 1000 })
    const fs = await import('../node-fs.js')
    const stat = await new Promise<import('../node-fs-stats.js').NodeStats>((resolve, reject) => {
      fs.stat('piece-0', (err, result) => (err !== null ? reject(err) : resolve(result as import('../node-fs-stats.js').NodeStats)))
    })
    expect(stat.isFile()).toBe(true)
    expect(stat.mtime.getTime()).toBe(1000)
  })

  it('rm forwards {recursive}', async () => {
    const { rmCalls } = installFakeOrivon()
    const fs = await import('../node-fs.js')
    await new Promise<void>((resolve, reject) => {
      fs.rm('torrents/abc', { recursive: true }, (err) => (err !== null ? reject(err) : resolve()))
    })
    expect(rmCalls).toEqual([{ path: 'torrents/abc', opts: { recursive: true } }])
  })

  it('rename forwards both paths', async () => {
    const { renameCalls } = installFakeOrivon()
    const fs = await import('../node-fs.js')
    await new Promise<void>((resolve, reject) => {
      fs.rename('tmp/x', 'torrents/x', (err) => (err !== null ? reject(err) : resolve()))
    })
    expect(renameCalls).toEqual([{ from: 'tmp/x', to: 'torrents/x' }])
  })
})

// A135: every fs member this module does not build used to be silently
// absent -- `fs.copyFile` read off the default export (a bundled CJS
// `require('fs')`'s own shape) threw a bare "copyFile is not a function".
describe('fs\'s other members -- named refusal instead of absence (A135), reading one is safe (A169)', () => {
  it('reading copyFile does not throw; calling it names it, reason unimplemented -- nothing has decided whether this will be built', async () => {
    installFakeOrivon()
    const fs = (await import('../node-fs.js')).default as unknown as Record<string, () => unknown>
    expect(() => fs.copyFile).not.toThrow()
    expect(() => fs.copyFile!()).toThrow(/fs\.copyFile/)
    try {
      fs.copyFile!()
    } catch (error) {
      const { OrivonShimError } = await import('../errors.js')
      expect(error).toBeInstanceOf(OrivonShimError)
      expect((error as InstanceType<typeof OrivonShimError>).reason).toBe('unimplemented')
    }
  })

  it.each(['chmod', 'chmodSync', 'chown', 'chownSync'])(
    'reading %s does not throw; calling it names it, reason not-applicable -- no POSIX permission model exists to set',
    async (member) => {
      installFakeOrivon()
      const fs = (await import('../node-fs.js')).default as unknown as Record<string, () => unknown>
      const { OrivonShimError } = await import('../errors.js')
      expect(() => fs[member]).not.toThrow()
      expect(() => fs[member]!()).toThrow(OrivonShimError)
      try {
        fs[member]!()
      } catch (error) {
        expect((error as InstanceType<typeof OrivonShimError>).reason).toBe('not-applicable')
      }
    }
  )

  // createReadStream/createWriteStream are real now (node-fs-streams.ts,
  // node-fs-streams.test.ts) -- see this file's own default export for why
  // they no longer route through otherFsMember.

  // A169's actual point: a library that merely probes an unbuilt member --
  // `typeof`, optional chaining, destructuring -- must never crash at
  // import just because it checked before calling.
  it('typeof, optional chaining and destructuring over an unbuilt member never throw', async () => {
    installFakeOrivon()
    const fs = (await import('../node-fs.js')).default as unknown as Record<string, unknown>
    expect(typeof fs.copyFile).toBe('function')
    expect(() => fs.copyFile ?? undefined).not.toThrow()
    expect(() => { const { copyFile } = fs as { copyFile?: unknown }; return copyFile }).not.toThrow()
  })

  it('still serves every real, already-built member unchanged through the same default export', async () => {
    installFakeOrivon()
    const fs = await import('../node-fs.js')
    expect(typeof fs.default.readFile).toBe('function')
    expect(typeof fs.default.open).toBe('function')
    expect(typeof fs.default.statSync).toBe('function')
  })

  it('lets `in` report an unbuilt member as truthfully absent', async () => {
    installFakeOrivon()
    const fs = (await import('../node-fs.js')).default as unknown as Record<string, unknown>
    expect('copyFile' in fs).toBe(false)
  })

})
