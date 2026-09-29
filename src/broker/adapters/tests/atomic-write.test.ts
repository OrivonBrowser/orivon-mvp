import { mkdtemp, readdir, readFile as fsReadFile } from 'node:fs/promises'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeFileAtomic, writeFileAtomicAsync } from '../atomic-write.js'

// The gate lets one test make the handle's own `writeFile` throw mid-write, without touching every other
// call through the real module. Declared through vi.hoisted because vi.mock's factory runs before the rest
// of this file. `opensByPath` proves writeFileAtomicAsync opens the temp file once, not once to write it and
// again to fsync it -- counted per path, since fsyncDirectoryAsync legitimately opens the directory too.
const syncGate = vi.hoisted(() => ({ failNextWith: null as Error | null }))
const asyncGate = vi.hoisted(() => ({ failNextWith: null as Error | null, opensByPath: new Map<string, number>() }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (syncGate.failNextWith !== null) {
        const failure = syncGate.failNextWith
        syncGate.failNextWith = null
        throw failure
      }
      return actual.writeFileSync(...args)
    }
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    // Only the three methods writeFileAtomicAsync actually calls are wrapped; the real handle is closed
    // over, not copied, so its other behaviour (and `this` binding) is untouched.
    open: async (...args: Parameters<typeof actual.open>) => {
      const key = String(args[0])
      asyncGate.opensByPath.set(key, (asyncGate.opensByPath.get(key) ?? 0) + 1)
      const handle = await actual.open(...args)
      return {
        writeFile: async (...writeArgs: Parameters<typeof handle.writeFile>) => {
          if (asyncGate.failNextWith !== null) {
            const failure = asyncGate.failNextWith
            asyncGate.failNextWith = null
            throw failure
          }
          return handle.writeFile(...writeArgs)
        },
        sync: () => handle.sync(),
        close: () => handle.close()
      }
    }
  }
})

describe('writeFileAtomic', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orivon-atomic-write-'))
    path = join(dir, 'value.json')
    syncGate.failNextWith = null
  })

  it('round-trips the text written', () => {
    writeFileAtomic(path, 'hello')
    expect(readFileSync(path, 'utf8')).toBe('hello')
  })

  it('overwrites whatever was there before', () => {
    writeFileAtomic(path, 'first')
    writeFileAtomic(path, 'second')
    expect(readFileSync(path, 'utf8')).toBe('second')
  })

  it('leaves no temp file behind -- it lands via rename, not a truncate in place', () => {
    writeFileAtomic(path, 'hello')
    expect(readdirSync(dir).sort()).toEqual(['value.json'])
  })

  it('a failed write leaves the previous file intact', () => {
    writeFileSync(path, 'original')
    syncGate.failNextWith = new Error('ENOSPC: no space left on device')

    expect(() => writeFileAtomic(path, 'replacement')).toThrow('ENOSPC')

    // The rename this depends on never ran, so the target is untouched --
    // a leftover, never-renamed temp file is harmless and is overwritten by
    // the next attempt.
    expect(readFileSync(path, 'utf8')).toBe('original')
  })
})

describe('writeFileAtomicAsync', () => {
  let dir: string
  let path: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orivon-atomic-write-async-'))
    path = join(dir, 'value.json')
    asyncGate.failNextWith = null
  })

  afterEach(() => {
    asyncGate.failNextWith = null
  })

  it('round-trips the text written', async () => {
    await writeFileAtomicAsync(path, 'hello')
    expect(await fsReadFile(path, 'utf8')).toBe('hello')
  })

  it('overwrites whatever was there before', async () => {
    await writeFileAtomicAsync(path, 'first')
    await writeFileAtomicAsync(path, 'second')
    expect(await fsReadFile(path, 'utf8')).toBe('second')
  })

  it('leaves no temp file behind -- it lands via rename, not a truncate in place', async () => {
    await writeFileAtomicAsync(path, 'hello')
    expect((await readdir(dir)).sort()).toEqual(['value.json'])
  })

  it('opens the temp file once, not once to write it and again to fsync it', async () => {
    asyncGate.opensByPath.clear()
    await writeFileAtomicAsync(path, 'hello')
    expect(asyncGate.opensByPath.get(`${path}.tmp`)).toBe(1)
  })

  it('a failed write leaves the previous file intact', async () => {
    writeFileSync(path, 'original')
    asyncGate.failNextWith = new Error('ENOSPC: no space left on device')

    await expect(writeFileAtomicAsync(path, 'replacement')).rejects.toThrow('ENOSPC')

    // The rename never ran, so the target is untouched -- a leftover, never-renamed temp file (open(tmp,
    // 'w') already created it before the write itself failed) is harmless and is overwritten next attempt.
    expect(await fsReadFile(path, 'utf8')).toBe('original')
  })
})
