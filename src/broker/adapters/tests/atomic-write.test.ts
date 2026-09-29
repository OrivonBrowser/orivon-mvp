import { mkdtemp, readdir, readFile as fsReadFile } from 'node:fs/promises'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeFileAtomic, writeFileAtomicAsync } from '../atomic-write.js'

// The gates let a test make one specific step throw, without touching every other call through the real
// module. Declared through vi.hoisted because vi.mock's factory runs before the rest of this file.
// `opensByPath` proves writeFileAtomicAsync opens the temp file once, not once to write it and again to
// fsync it -- counted per path, since fsyncDirectoryAsync legitimately opens the directory too.
const syncGate = vi.hoisted(() => ({
  failWriteWith: null as Error | null,
  failRenameWith: null as Error | null,
  firstOpenPath: null as string | null
}))
const asyncGate = vi.hoisted(() => ({
  failWriteWith: null as Error | null,
  failRenameWith: null as Error | null,
  opensByPath: new Map<string, number>()
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      syncGate.firstOpenPath ??= String(args[0])
      return actual.openSync(...args)
    },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (syncGate.failWriteWith !== null) {
        const failure = syncGate.failWriteWith
        syncGate.failWriteWith = null
        throw failure
      }
      return actual.writeFileSync(...args)
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (syncGate.failRenameWith !== null) {
        const failure = syncGate.failRenameWith
        syncGate.failRenameWith = null
        throw failure
      }
      return actual.renameSync(...args)
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
          if (asyncGate.failWriteWith !== null) {
            const failure = asyncGate.failWriteWith
            asyncGate.failWriteWith = null
            throw failure
          }
          return handle.writeFile(...writeArgs)
        },
        sync: () => handle.sync(),
        close: () => handle.close()
      }
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (asyncGate.failRenameWith !== null) {
        const failure = asyncGate.failRenameWith
        asyncGate.failRenameWith = null
        throw failure
      }
      return actual.rename(...args)
    }
  }
})

describe('writeFileAtomic', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orivon-atomic-write-'))
    path = join(dir, 'value.json')
    syncGate.failWriteWith = null
    syncGate.failRenameWith = null
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

  it('a failed write leaves the previous file intact, and no .tmp file behind', () => {
    writeFileSync(path, 'original')
    syncGate.failWriteWith = new Error('ENOSPC: no space left on device')

    expect(() => writeFileAtomic(path, 'replacement')).toThrow('ENOSPC')

    // The rename this depends on never ran, so the target is untouched; the
    // temp file the failed write left is unlinked before the error is rethrown.
    expect(readFileSync(path, 'utf8')).toBe('original')
    expect(readdirSync(dir)).toEqual(['value.json'])
  })

  it('a failing rename leaves no .tmp file behind', () => {
    syncGate.failRenameWith = new Error('EACCES: permission denied')

    expect(() => writeFileAtomic(path, 'hello')).toThrow('EACCES')

    expect(readdirSync(dir)).toEqual([])
  })

  it('the temp name carries this process\'s pid', () => {
    syncGate.firstOpenPath = null
    writeFileAtomic(path, 'hello')
    expect(syncGate.firstOpenPath).toBe(`${path}.${String(process.pid)}.tmp`)
  })

  it('a failing write leaves alone a leftover .tmp belonging to another pid', () => {
    const otherPidTmp = join(dir, 'value.json.999999999.tmp')
    writeFileSync(otherPidTmp, 'left behind by another process')
    syncGate.failWriteWith = new Error('ENOSPC: no space left on device')

    expect(() => writeFileAtomic(path, 'replacement')).toThrow('ENOSPC')

    expect(readFileSync(otherPidTmp, 'utf8')).toBe('left behind by another process')
  })
})

describe('writeFileAtomicAsync', () => {
  let dir: string
  let path: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orivon-atomic-write-async-'))
    path = join(dir, 'value.json')
    asyncGate.failWriteWith = null
    asyncGate.failRenameWith = null
  })

  afterEach(() => {
    asyncGate.failWriteWith = null
    asyncGate.failRenameWith = null
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
    expect(asyncGate.opensByPath.get(`${path}.${String(process.pid)}.tmp`)).toBe(1)
  })

  it('the temp name carries this process\'s pid', async () => {
    asyncGate.opensByPath.clear()
    await writeFileAtomicAsync(path, 'hello')
    expect([...asyncGate.opensByPath.keys()]).toContain(`${path}.${String(process.pid)}.tmp`)
  })

  it('a failing write leaves alone a leftover .tmp belonging to another pid', async () => {
    const otherPidTmp = join(dir, 'value.json.999999999.tmp')
    writeFileSync(otherPidTmp, 'left behind by another process')
    asyncGate.failWriteWith = new Error('ENOSPC: no space left on device')

    await expect(writeFileAtomicAsync(path, 'replacement')).rejects.toThrow('ENOSPC')

    expect(await fsReadFile(otherPidTmp, 'utf8')).toBe('left behind by another process')
  })

  it('a failed write leaves the previous file intact, and no .tmp file behind', async () => {
    writeFileSync(path, 'original')
    asyncGate.failWriteWith = new Error('ENOSPC: no space left on device')

    await expect(writeFileAtomicAsync(path, 'replacement')).rejects.toThrow('ENOSPC')

    // The rename never ran, so the target is untouched; the temp file open(tmp, 'w') created before the
    // write itself failed is unlinked before the error is rethrown.
    expect(await fsReadFile(path, 'utf8')).toBe('original')
    expect((await readdir(dir)).sort()).toEqual(['value.json'])
  })

  it('a failing rename leaves no .tmp file behind', async () => {
    asyncGate.failRenameWith = new Error('EACCES: permission denied')

    await expect(writeFileAtomicAsync(path, 'hello')).rejects.toThrow('EACCES')

    expect(await readdir(dir)).toEqual([])
  })
})
