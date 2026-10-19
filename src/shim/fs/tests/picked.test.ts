// fs on a stand-in path (shim-electron/picked-paths.ts): every call lands on the pick's own handle, and a
// path that is not one takes the app-root route unchanged. The picks here are in-memory fakes of the handles
// orivon.fs.userSelected returns; a real picker is proven end to end by test/app-behaviours/.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Orivon } from '../../../contracts/capability-api.js'
import type { FileHandle } from '../../../contracts/handles.js'
import { createFakeDirectoryHandle } from '../../tests/support/fake-directory-handle.js'
import { createFakeFileHandle } from '../../tests/support/fake-file-handle.js'

type GlobalWithOrivon = typeof globalThis & { orivon?: Orivon }

afterEach(() => {
  delete (globalThis as GlobalWithOrivon).orivon
  vi.resetModules()
})

/** The shim's fs and the registry, loaded together so they share one table of picks. */
async function load () {
  const registry = await import('../../../shim-electron/picked-paths.js')
  const fs = await import('../fs.js')
  const promises = await import('../promises.js')
  return { ...registry, fs, promises }
}

/** A picked file whose handle records its truncate and sync calls beside the fake's reads and writes. */
function pickedFile (text: string) {
  const fake = createFakeFileHandle(new TextEncoder().encode(text))
  const events: string[] = []
  const handle: FileHandle = {
    ...fake.handle,
    close: async () => { events.push('close'); await fake.handle.close() },
    truncate: async (length) => { events.push(`truncate ${String(length)}`); await fake.handle.truncate(length) },
    sync: async () => { events.push('sync') }
  }
  return { fake, handle, events }
}

const text = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes)

describe('a picked file', () => {
  it('readFile returns its bytes, decoded when an encoding is given', async () => {
    const { registerPickedFile, promises } = await load()
    const { handle } = pickedFile('hello picked file')
    const path = registerPickedFile(handle, 'note.txt')
    expect(text(await promises.readFile(path) as Uint8Array)).toBe('hello picked file')
    expect(await promises.readFile(path, 'utf8')).toBe('hello picked file')
  })

  it('reads a large file in chunks of a megabyte, never one call for all of it', async () => {
    const { registerPickedFile, promises } = await load()
    const size = 2.5 * 1024 * 1024
    const { handle, fake } = pickedFile('')
    await handle.write({ position: 0, data: new Uint8Array(size).fill(7) })
    fake.readCalls.length = 0
    const bytes = await promises.readFile(registerPickedFile(handle, 'big.bin')) as Uint8Array
    expect(bytes.length).toBe(size)
    expect(fake.readCalls.map((call) => call.length)).toEqual([1048576, 1048576, 524288])
  })

  it('stat answers a file, and the picked folder around it answers a directory holding just the file', async () => {
    const { registerPickedFile, promises } = await load()
    const path = registerPickedFile(pickedFile('12345').handle, 'five.txt')
    const stat = await promises.stat(path)
    expect(stat.isFile()).toBe(true)
    expect(stat.size).toBe(5)
    const folder = path.slice(0, path.lastIndexOf('/'))
    expect((await promises.stat(folder)).isDirectory()).toBe(true)
    expect(await promises.readdir(folder)).toEqual(['five.txt'])
    const [entry] = await promises.readdir(folder, { withFileTypes: true })
    expect(entry?.name).toBe('five.txt')
    expect(entry?.isFile()).toBe(true)
  })

  it('writeFile empties the file first, then writes, then flushes', async () => {
    const { registerPickedFile, promises } = await load()
    const { handle, fake, events } = pickedFile('a much longer earlier content')
    await promises.writeFile(registerPickedFile(handle, 'out.txt'), 'short')
    expect(text(fake.bytes())).toBe('short')
    expect(events).toEqual(['truncate 0', 'sync'])
  })

  it('appendFile writes at the end', async () => {
    const { registerPickedFile, promises } = await load()
    const { handle, fake } = pickedFile('one')
    await promises.appendFile(registerPickedFile(handle, 'log.txt'), '+two')
    expect(text(fake.bytes())).toBe('one+two')
  })

  it('fs.promises.open keeps a cursor, and closing it flushes a writer but leaves the pick usable', async () => {
    const { registerPickedFile, promises } = await load()
    const { handle, fake, events } = pickedFile('abcdef')
    const path = registerPickedFile(handle, 'f.bin')
    const reader = await promises.open(path, 'r')
    const buffer = new Uint8Array(3)
    await reader.read(buffer)
    expect(text(buffer)).toBe('abc')
    await reader.close()
    expect(events).not.toContain('close')
    expect(events).not.toContain('sync')
    const writer = await promises.open(path, 'r+')
    await writer.write(new TextEncoder().encode('XY'), 0, 2, 1)
    await writer.close()
    expect(events).toEqual(['sync'])
    expect(text(fake.bytes())).toBe('aXYdef')
    expect(await promises.readFile(path, 'utf8')).toBe('aXYdef')
  })

  it("open 'w' empties the file and 'wx' refuses it as existing", async () => {
    const { registerPickedFile, promises } = await load()
    const { handle, events } = pickedFile('keep me?')
    const path = registerPickedFile(handle, 'w.txt')
    await expect(promises.open(path, 'wx')).rejects.toMatchObject({ code: 'EEXIST' })
    expect(events).toEqual([])
    const writer = await promises.open(path, 'w')
    await writer.close()
    expect(events).toEqual(['truncate 0', 'sync'])
  })

  it('createReadStream streams a range of it and createWriteStream writes through the same handle', async () => {
    const { registerPickedFile, fs } = await load()
    const { handle, fake } = pickedFile('0123456789')
    const path = registerPickedFile(handle, 's.txt')
    const read = await new Promise<string>((resolve, reject) => {
      let out = ''
      const stream = fs.createReadStream(path, { start: 2, end: 5, encoding: 'utf8' })
      stream.on('data', (chunk) => { out += String(chunk) })
      stream.on('end', () => resolve(out))
      stream.on('error', reject)
    })
    expect(read).toBe('2345')
    await new Promise<void>((resolve, reject) => {
      const stream = fs.createWriteStream(path, { flags: 'r+', start: 8 })
      stream.on('close', resolve)
      stream.on('error', reject)
      stream.end('XY')
    })
    expect(text(fake.bytes())).toBe('01234567XY')
  })

  it('the callback family reaches it too', async () => {
    const { registerPickedFile, fs } = await load()
    const path = registerPickedFile(pickedFile('callback').handle, 'cb.txt')
    expect(await new Promise((resolve) => { fs.readFile(path, 'utf8', (_error, result) => { resolve(result) }) })).toBe('callback')
    expect(await new Promise((resolve) => { fs.stat(path, (_error, result) => { resolve(result?.size) }) })).toBe(8)
    expect(await new Promise((resolve) => { fs.access(path, (error) => { resolve(error) }) })).toBeNull()
  })

  it('another name in its folder does not exist, cannot be created, and nothing can be removed or renamed', async () => {
    const { registerPickedFile, promises } = await load()
    const path = registerPickedFile(pickedFile('x').handle, 'only.txt')
    const folder = path.slice(0, path.lastIndexOf('/'))
    await expect(promises.readFile(`${folder}/other.txt`)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(promises.access(`${folder}/other.txt`)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(promises.writeFile(`${folder}/other.txt`, 'y')).rejects.toMatchObject({ code: 'EACCES' })
    await expect(promises.open(`${folder}/other.txt`, 'w')).rejects.toMatchObject({ code: 'EACCES' })
    await expect(promises.rm(path)).rejects.toMatchObject({ code: 'EACCES' })
    await expect(promises.unlink(path)).rejects.toMatchObject({ code: 'EACCES' })
    await expect(promises.rename(path, `${folder}/moved.txt`)).rejects.toMatchObject({ code: 'EACCES' })
  })

  it('mkdir -p of its folder succeeds, as Node does for a directory that exists', async () => {
    const { registerPickedFile, promises } = await load()
    const path = registerPickedFile(pickedFile('x').handle, 'only.txt')
    const folder = path.slice(0, path.lastIndexOf('/'))
    await expect(promises.mkdir(folder, { recursive: true })).resolves.toBeUndefined()
    await expect(promises.mkdir(folder)).rejects.toMatchObject({ code: 'EEXIST' })
  })

  it('realpath is the stand-in itself once it exists', async () => {
    const { registerPickedFile, promises } = await load()
    const path = registerPickedFile(pickedFile('x').handle, 'only.txt')
    expect(await promises.realpath(`${path.slice(0, path.lastIndexOf('/'))}/./only.txt`)).toBe(path)
  })
})

describe('fs.watch and a picked path', () => {
  it('a write to a pick is announced to no watcher of the app\'s files', async () => {
    const { registerPickedFile, promises } = await load()
    const { subscribe } = await import('../notices.js')
    const heard: string[] = []
    const stop = subscribe((path) => { heard.push(path) })
    const writer = await promises.open(registerPickedFile(pickedFile('abc').handle, 'w.txt'), 'r+')
    await writer.write(new TextEncoder().encode('Z'), 0, 1, 0)
    await writer.truncate(1)
    await writer.close()
    await new Promise((resolve) => setTimeout(resolve, 10))
    stop()
    expect(heard).toEqual([])
  })
})

describe('a picked folder', () => {
  async function folder () {
    const loaded = await load()
    const fake = createFakeDirectoryHandle()
    fake.put('docs/a.txt', 'alpha')
    fake.put('b.txt', 'beta')
    return { ...loaded, fake, root: loaded.registerPickedDirectory(fake.handle) }
  }

  it('lists its root and a folder inside, with kinds', async () => {
    const { promises, root } = await folder()
    expect(await promises.readdir(root)).toEqual(['b.txt', 'docs'])
    expect(await promises.readdir(`${root}/docs`)).toEqual(['a.txt'])
    const entries = await promises.readdir(root, { withFileTypes: true })
    expect(entries.map((entry) => [entry.name, entry.isDirectory()])).toEqual([['b.txt', false], ['docs', true]])
    expect((await promises.stat(root)).isDirectory()).toBe(true)
    expect((await promises.stat(`${root}/docs/a.txt`)).size).toBe(5)
  })

  it('reads and writes files inside it, creating folders on the way', async () => {
    const { promises, root, fake } = await folder()
    expect(await promises.readFile(`${root}/docs/a.txt`, 'utf8')).toBe('alpha')
    await promises.mkdir(`${root}/out/deep`, { recursive: true })
    await promises.writeFile(`${root}/out/deep/c.txt`, 'gamma')
    expect(text(fake.bytes('out/deep/c.txt'))).toBe('gamma')
    expect(fake.calls).toContain('writeFile out/deep/c.txt')
  })

  it('open, createReadStream and createWriteStream work positionally inside it', async () => {
    const { promises, fs, root, fake } = await folder()
    const writer = await promises.open(`${root}/out.bin`, 'w')
    await writer.write(new TextEncoder().encode('0123'), 0, 4, 0)
    await writer.write(new TextEncoder().encode('89'), 0, 2, 8)
    await writer.close()
    expect(fake.bytes('out.bin')?.length).toBe(10)
    const piped = await new Promise<string>((resolve, reject) => {
      let out = ''
      const stream = fs.createReadStream(`${root}/docs/a.txt`, { encoding: 'utf8' })
      stream.on('data', (chunk) => { out += String(chunk) })
      stream.on('end', () => resolve(out))
      stream.on('error', reject)
    })
    expect(piped).toBe('alpha')
    await new Promise<void>((resolve, reject) => {
      const stream = fs.createWriteStream(`${root}/streamed.txt`)
      stream.on('close', resolve)
      stream.on('error', reject)
      stream.end('streamed')
    })
    expect(text(fake.bytes('streamed.txt'))).toBe('streamed')
  })

  it('rm, unlink, rename and rmdir act inside it, with Node\'s errors for the cases Node tells apart', async () => {
    const { promises, root, fake } = await folder()
    await promises.rename(`${root}/b.txt`, `${root}/docs/b2.txt`)
    expect(fake.has('b.txt')).toBe(false)
    expect(fake.has('docs/b2.txt')).toBe(true)
    await promises.unlink(`${root}/docs/b2.txt`)
    await expect(promises.rmdir(`${root}/docs`)).rejects.toMatchObject({ code: 'ENOTEMPTY' })
    await expect(promises.rmdir(`${root}/docs/a.txt`)).rejects.toMatchObject({ code: 'ENOTDIR' })
    await promises.rm(`${root}/docs`, { recursive: true })
    expect(fake.has('docs')).toBe(false)
    await expect(promises.rm(`${root}/missing.txt`)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(promises.rm(`${root}/missing.txt`, { force: true })).resolves.toBeUndefined()
  })

  it('a missing file is ENOENT, and the folder itself cannot be removed, moved or read as a file', async () => {
    const { promises, root } = await folder()
    await expect(promises.readFile(`${root}/nope.txt`)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(promises.stat(`${root}/nope.txt`)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(promises.rm(root, { recursive: true })).rejects.toMatchObject({ code: 'EACCES' })
    await expect(promises.rename(root, `${root}/inside`)).rejects.toMatchObject({ code: 'EACCES' })
    await expect(promises.readFile(root)).rejects.toMatchObject({ code: 'EISDIR' })
    await expect(promises.writeFile(root, 'x')).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('a rename out of the folder, or between two picks, is a different device', async () => {
    const { promises, root, registerPickedDirectory } = await folder()
    const other = registerPickedDirectory(createFakeDirectoryHandle().handle)
    await expect(promises.rename(`${root}/b.txt`, `${other}/b.txt`)).rejects.toMatchObject({ code: 'EXDEV' })
    await expect(promises.rename(`${root}/b.txt`, '/orivon/app/b.txt')).rejects.toMatchObject({ code: 'EXDEV' })
    await expect(promises.rename('/orivon/app/b.txt', `${root}/b.txt`)).rejects.toMatchObject({ code: 'EXDEV' })
  })

  it('a .. cannot leave the folder for the host: the handle never sees it', async () => {
    const { promises, root, fake } = await folder()
    await expect(promises.readFile(`${root}/../../../etc/passwd`)).rejects.toMatchObject({ code: 'EACCES' })
    await expect(promises.readFile(`${root}/docs/../../../..`)).rejects.toMatchObject({ code: 'EACCES' })
    expect(fake.calls.filter((call) => call.includes('..'))).toEqual([])
  })

  it('a .. that stays in the folder is resolved before the handle is asked', async () => {
    const { promises, root, fake } = await folder()
    expect(await promises.readFile(`${root}/docs/../docs/./a.txt`, 'utf8')).toBe('alpha')
    expect(fake.calls).toEqual(['readFile docs/a.txt'])
  })

  it('a .. out of the folder and into the app root reads the app root, not the pick', async () => {
    const { promises, root } = await folder()
    const readFile = vi.fn(async () => new TextEncoder().encode('from the app'))
    ;(globalThis as GlobalWithOrivon).orivon = { fs: { readFile } } as unknown as Orivon
    expect(await promises.readFile(`${root}/../../app/notes.txt`, 'utf8')).toBe('from the app')
    expect(readFile).toHaveBeenCalledWith('notes.txt')
  })

  it('and the app root cannot reach a pick by relative or climbing paths either', async () => {
    const { promises, root } = await folder()
    await expect(promises.readFile('../picked/x/y')).rejects.toMatchObject({ code: 'EACCES' })
    expect(await promises.readFile(`/orivon/app/../picked/${root.split('/')[3]}/b.txt`, 'utf8')).toBe('beta')
  })
})

describe('a stand-in that no pick answers', () => {
  it('fails as a missing file whose message says to pick again, for every call and for a stream', async () => {
    const { promises, fs } = await load()
    const path = '/orivon/picked/aaaaaaaaaaaaaaaaaaaaaaaa/video.mp4'
    for (const call of [
      async () => await promises.readFile(path), async () => await promises.writeFile(path, 'x'), async () => await promises.stat(path),
      async () => await promises.open(path, 'r'), async () => await promises.readdir(path), async () => await promises.mkdir(path),
      async () => await promises.rm(path), async () => await promises.access(path), async () => await promises.rename(path, `${path}2`)
    ]) {
      const error = await call().then(() => undefined, (caught: Error) => caught) as (Error & { code: string, syscall: string, path: string }) | undefined
      expect(error?.code).toBe('ENOENT')
      expect(error?.message).toMatch(/pick(ed)? .*(reload|revoked).*pick/i)
      expect(error?.path).toBe(path)
    }
    const streamError = await new Promise<Error & { code: string }>((resolve) => { fs.createReadStream(path).on('error', resolve) })
    expect(streamError.code).toBe('ENOENT')
  })

  it('the list of picks is not browsable', async () => {
    const { promises } = await load()
    await expect(promises.readdir('/orivon/picked')).rejects.toMatchObject({ code: 'EACCES' })
    await expect(promises.stat('/orivon/picked/')).rejects.toMatchObject({ code: 'EACCES' })
  })

  it('a revoked pick reads as stale from then on, not as an error from inside the handle', async () => {
    const { registerPickedFile, promises } = await load()
    let revoke: () => void = () => {}
    const { handle } = pickedFile('x')
    const closed = new Promise<void>((resolve) => { revoke = resolve })
    const path = registerPickedFile({ ...handle, closed }, 'r.txt')
    await promises.readFile(path)
    revoke()
    await closed
    await expect(promises.readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('the synchronous family on a picked path', () => {
  it('refuses each call with an error that says a pick has no synchronous wire', async () => {
    const { registerPickedFile, registerPickedDirectory, fs } = await load()
    const file = registerPickedFile(pickedFile('x').handle, 'a.txt')
    const folder = registerPickedDirectory(createFakeDirectoryHandle().handle)
    const calls: Array<() => unknown> = [
      () => fs.readFileSync(file), () => fs.statSync(file), () => fs.lstatSync(file), () => fs.writeFileSync(file, 'x'),
      () => fs.appendFileSync(file, 'x'), () => fs.readdirSync(folder), () => fs.mkdirSync(`${folder}/x`), () => fs.rmSync(file),
      () => fs.unlinkSync(file), () => fs.renameSync(file, `${file}2`), () => fs.accessSync(file), () => fs.openSync(file, 'r'),
      () => fs.realpathSync(file), () => fs.watch(file)
    ]
    for (const call of calls) {
      let caught: (Error & { code?: string }) | undefined
      try { call() } catch (error) { caught = error as Error }
      expect(caught?.code).toBe('ENOSYS')
      expect(caught?.message).toMatch(/no synchronous wire/)
    }
  })

  it('copyFileSync throws too, whether or not this context could have made the call synchronous', async () => {
    const { registerPickedFile, fs } = await load()
    const file = registerPickedFile(pickedFile('x').handle, 'a.txt')
    expect(() => fs.copyFileSync(file, `${file}2`)).toThrow()
  })

  it('existsSync answers false, since Node\'s never throws and a pick cannot be looked at synchronously', async () => {
    const { registerPickedFile, fs } = await load()
    expect(fs.existsSync(registerPickedFile(pickedFile('x').handle, 'a.txt'))).toBe(false)
  })
})
