// readFileSync and existsSync: the two synchronous fs calls, both over
// orivon.fs.readFileSync, ADR-0016's one synchronous entry point.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Orivon } from '../../contracts/capability-api.js'
import { VIRTUAL_ROOT } from '../virtual-root.js'

type GlobalWithOrivon = typeof globalThis & { orivon?: Orivon }

function orivonError (code: string, platformCode?: string): Error {
  return Object.assign(new Error(`${code} failure`), { name: 'OrivonError', code, ...(platformCode === undefined ? {} : { platformCode }) })
}

/** `entries` maps a confined path to its bytes, or to the error the broker would throw for it. */
function installFakeOrivon (entries: Record<string, Uint8Array | Error>): string[] {
  const reads: string[] = []
  ;(globalThis as GlobalWithOrivon).orivon = {
    fs: {
      readFileSync: (path: string) => {
        reads.push(path)
        const entry = entries[path]
        if (entry === undefined) throw orivonError('notFound', 'ENOENT')
        if (entry instanceof Error) throw entry
        return entry
      }
    }
  } as unknown as Orivon
  return reads
}

afterEach(() => {
  delete (globalThis as GlobalWithOrivon).orivon
  vi.resetModules()
})

describe('fs.readFileSync', () => {
  it('maps a broker failure to Node\'s errno, as the async calls do', async () => {
    installFakeOrivon({})
    const fs = await import('../node-fs.js')
    expect(() => fs.readFileSync('missing.json')).toThrow(expect.objectContaining({ code: 'ENOENT', orivonCode: 'notFound' }))
  })

  it('keeps a denial as \'denied\', never a fake errno', async () => {
    installFakeOrivon({ secret: orivonError('denied') })
    const fs = await import('../node-fs.js')
    expect(() => fs.readFileSync('secret')).toThrow(expect.objectContaining({ code: 'denied' }))
  })

  it('reading the root is EISDIR, answered locally', async () => {
    const reads = installFakeOrivon({})
    const fs = await import('../node-fs.js')
    expect(() => fs.readFileSync(VIRTUAL_ROOT)).toThrow(expect.objectContaining({ code: 'EISDIR' }))
    expect(reads).toEqual([])
  })
})

describe('fs.existsSync', () => {
  it('is true for a file it can read, false for a missing one', async () => {
    installFakeOrivon({ 'settings.json': new Uint8Array([1]) })
    const fs = await import('../node-fs.js')
    expect(fs.existsSync('settings.json')).toBe(true)
    expect(fs.existsSync(`${VIRTUAL_ROOT}/settings.json`)).toBe(true)
    expect(fs.existsSync('missing.json')).toBe(false)
  })

  // Reading a directory fails EISDIR, which proves it exists.
  it('is true for a directory', async () => {
    installFakeOrivon({ torrents: orivonError('internal', 'EISDIR') })
    const fs = await import('../node-fs.js')
    expect(fs.existsSync('torrents')).toBe(true)
  })

  it('is true for the root, without asking the broker', async () => {
    const reads = installFakeOrivon({})
    const fs = await import('../node-fs.js')
    expect(fs.existsSync(VIRTUAL_ROOT)).toBe(true)
    expect(fs.existsSync('.')).toBe(true)
    expect(reads).toEqual([])
  })

  // Node's existsSync returns false for anything it cannot confirm, a
  // permission failure included, and never throws.
  it('is false outside the root, for a denied path, and for a bad argument', async () => {
    const reads = installFakeOrivon({ secret: orivonError('denied') })
    const fs = await import('../node-fs.js')
    expect(fs.existsSync('/etc/passwd')).toBe(false)
    expect(fs.existsSync('secret')).toBe(false)
    expect(fs.existsSync(42 as unknown as string)).toBe(false)
    expect(reads).toEqual(['secret'])
  })
})

describe('the other synchronous calls', () => {
  it('still refuse by name', async () => {
    installFakeOrivon({})
    const fs = await import('../node-fs.js')
    expect(() => fs.statSync('x')).toThrow(expect.objectContaining({ api: 'fs.statSync', code: 'ERR_ORIVON_FS_SYNC_UNSUPPORTED' }))
  })
})
