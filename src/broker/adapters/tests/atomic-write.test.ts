import { mkdtemp, readdir, readFile as fsReadFile } from 'node:fs/promises'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeFileAtomic, writeFileAtomicAsync } from '../atomic-write.js'

// The gate lets one test hold `writeFileSync` open long enough to fail it
// mid-write, without touching every other call through the real module.
// Declared through vi.hoisted because vi.mock's factory runs before the
// rest of this file.
const syncGate = vi.hoisted(() => ({ failNextWith: null as Error | null }))
const asyncGate = vi.hoisted(() => ({ failNextWith: null as Error | null }))

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
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (asyncGate.failNextWith !== null) {
        const failure = asyncGate.failNextWith
        asyncGate.failNextWith = null
        throw failure
      }
      return actual.writeFile(...args)
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

  it('a failed write leaves the previous file intact', async () => {
    writeFileSync(path, 'original')
    asyncGate.failNextWith = new Error('ENOSPC: no space left on device')

    await expect(writeFileAtomicAsync(path, 'replacement')).rejects.toThrow('ENOSPC')

    expect(await fsReadFile(path, 'utf8')).toBe('original')
    expect((await readdir(dir)).sort()).toEqual(['value.json'])
  })
})
