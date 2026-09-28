// wasi:filesystem over a real temporary directory standing in for the
// broker, driven the way jco's glue calls the host.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRealDiskFs, type RealDiskFs } from '../../tests/support/real-disk-fs.js'
import { type Descriptor, filesystemInterfaces } from '../filesystem.js'

let disk: RealDiskFs | undefined

afterEach(async () => {
  await disk?.cleanup()
  disk = undefined
})

async function root (): Promise<Descriptor> {
  disk = await createRealDiskFs()
  const preopens = filesystemInterfaces(disk.orivon.fs, { '/': '/orivon/app' })['wasi:filesystem/preopens']?.getDirectories as () => Array<[Descriptor, string]>
  const [[descriptor, name] = []] = preopens()
  expect(name).toBe('/')
  return descriptor as Descriptor
}

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

describe('wasi:filesystem', () => {
  it('creates a file, writes and reads it through streams and at offsets, and stats it', async () => {
    const dir = await root()
    const file = await dir.openAt({}, 'notes.txt', { create: true }, { read: true, write: true })
    await file.writeViaStream(0n).blockingWriteAndFlush(new TextEncoder().encode('hello world'))
    expect(text(await file.readViaStream(6n).blockingRead(100n))).toBe('world')
    expect(await file.write(new TextEncoder().encode('J'), 0n)).toBe(1n)
    expect(await file.read(5n, 0n)).toEqual([new TextEncoder().encode('Jello'), false])
    expect(await file.read(100n, 6n)).toEqual([new TextEncoder().encode('world'), true])
    expect(await file.stat()).toMatchObject({ type: 'regular-file', size: 11n })
    expect(await dir.statAt({}, 'notes.txt')).toMatchObject({ type: 'regular-file', size: 11n })
    file[Symbol.dispose]()
    expect(readFileSync(join(disk?.root ?? '', 'notes.txt'), 'utf8')).toBe('Jello world')
  })

  it('appends at the end whatever the stream was opened at', async () => {
    const dir = await root()
    writeFileSync(join(disk?.root ?? '', 'log.txt'), 'one\n')
    const file = await dir.openAt({}, 'log.txt', {}, { write: true })
    await file.appendViaStream().blockingWriteAndFlush(new TextEncoder().encode('two\n'))
    file[Symbol.dispose]()
    expect(readFileSync(join(disk?.root ?? '', 'log.txt'), 'utf8')).toBe('one\ntwo\n')
  })

  it('lists a directory without . and .., each entry typed', async () => {
    const dir = await root()
    mkdirSync(join(disk?.root ?? '', 'sub'))
    writeFileSync(join(disk?.root ?? '', 'sub', 'a.txt'), 'a')
    mkdirSync(join(disk?.root ?? '', 'sub', 'inner'))
    const sub = await dir.openAt({}, 'sub', { directory: true }, { read: true })
    const stream = await sub.readDirectory()
    const entries = []
    for (let entry = stream.readDirectoryEntry(); entry !== undefined; entry = stream.readDirectoryEntry()) entries.push(entry)
    expect(entries.sort((x, y) => x.name.localeCompare(y.name))).toEqual([{ type: 'regular-file', name: 'a.txt' }, { type: 'directory', name: 'inner' }])
  })

  it('creates, renames and removes, refusing as POSIX does', async () => {
    const dir = await root()
    await dir.createDirectoryAt('made')
    await expect(dir.createDirectoryAt('made')).rejects.toBe('exist')
    const file = await dir.openAt({}, 'made/f', { create: true, exclusive: true }, { write: true })
    file[Symbol.dispose]()
    await expect(dir.openAt({}, 'made/f', { create: true, exclusive: true }, { write: true })).rejects.toBe('exist')
    await expect(dir.removeDirectoryAt('made')).rejects.toBe('not-empty')
    await dir.renameAt('made/f', dir, 'moved')
    await expect(dir.unlinkFileAt('made')).rejects.toBe('is-directory')
    await dir.removeDirectoryAt('made')
    await dir.unlinkFileAt('moved')
    await expect(dir.statAt({}, 'moved')).rejects.toBe('no-entry')
  })

  it('refuses a path that leaves the directory, a missing file without create, and writing a directory', async () => {
    const dir = await root()
    await expect(dir.openAt({}, '../escape', {}, { read: true })).rejects.toBe('not-permitted')
    await expect(dir.openAt({}, '/etc/passwd', {}, { read: true })).rejects.toBe('not-permitted')
    await expect(dir.openAt({}, 'absent', {}, { read: true })).rejects.toBe('no-entry')
    mkdirSync(join(disk?.root ?? '', 'd'))
    await expect(dir.openAt({}, 'd', {}, { write: true })).rejects.toBe('is-directory')
    await expect(dir.readlinkAt('d')).rejects.toBe('invalid')
    expect(() => dir.symlinkAt()).toThrow()
  })

  it('answers the app root itself locally, as the Node shim does, since the broker refuses it', async () => {
    const dir = await root()
    expect(await dir.stat()).toMatchObject({ type: 'directory' })
    expect(dir.getType()).toBe('directory')
    await expect(dir.createDirectoryAt('.')).rejects.toBe('exist')
  })

  it('names a failed stream\'s cause through filesystem-error-code', async () => {
    const dir = await root()
    const file = await dir.openAt({}, 'gone.txt', { create: true }, { read: true, write: true })
    file[Symbol.dispose]()
    await new Promise((resolve) => setTimeout(resolve, 10))
    const error = await file.readViaStream(0n).blockingRead(4n).catch((thrown: unknown) => thrown) as { tag: string, val: { code?: string } }
    expect(error.tag).toBe('last-operation-failed')
    const errorCode = filesystemInterfaces({} as never, {})['wasi:filesystem/types']?.filesystemErrorCode as (error: unknown) => string | undefined
    expect(errorCode(error.val)).toBe(error.val.code)
    expect(typeof error.val.code).toBe('string')
  })
})
