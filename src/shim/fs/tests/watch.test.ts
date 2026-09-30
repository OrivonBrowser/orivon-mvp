// fs.watch over the notices every mutating call announces. Stubs orivon.fs
// with a small in-memory tree; a second copy of the module (vi.resetModules)
// stands for another context of the same app, reached over the BroadcastChannel.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Orivon } from '../../../contracts/capability-api.js'
import { FORK_LIVENESS_SYMBOL } from '../../worker/symbols.js'
import { createFakeFileHandle } from '../../tests/support/fake-file-handle.js'

type GlobalWithOrivon = typeof globalThis & { orivon?: Orivon }
type Event = [string, string]

function orivonError (code: string, platformCode: string): Error {
  return Object.assign(new Error(platformCode), { name: 'OrivonError', code, platformCode })
}

function installFakeOrivon (): { files: Map<string, Uint8Array>, dirs: Set<string> } {
  const files = new Map<string, Uint8Array>()
  const dirs = new Set<string>(['users'])
  ;(globalThis as GlobalWithOrivon).orivon = {
    fs: {
      stat: async (path: string) => {
        if (files.has(path)) return { size: files.get(path)!.length, isFile: true, isDirectory: false, mtimeMs: 0 }
        if (dirs.has(path)) return { size: 0, isFile: false, isDirectory: true, mtimeMs: 0 }
        throw orivonError('notFound', 'ENOENT')
      },
      readFileSync: (path: string) => {
        if (dirs.has(path)) throw orivonError('invalid', 'EISDIR')
        const data = files.get(path)
        if (data === undefined) throw orivonError('notFound', 'ENOENT')
        return data
      },
      writeFile: async (path: string, data: Uint8Array) => { files.set(path, data) },
      mkdir: async (path: string) => { dirs.add(path) },
      rm: async (path: string) => { if (!files.delete(path) && !dirs.delete(path)) throw orivonError('notFound', 'ENOENT') },
      rename: async (from: string, to: string) => { files.set(to, files.get(from) ?? new Uint8Array()); files.delete(from) },
      open: async (path: string) => {
        const created = !files.has(path)
        const fake = createFakeFileHandle(files.get(path) ?? new Uint8Array(0))
        if (created) files.set(path, new Uint8Array(0))
        const write = fake.handle.write.bind(fake.handle)
        fake.handle.write = async (opts) => { const written = await write(opts); files.set(path, fake.bytes()); return written }
        return fake.handle
      }
    }
  } as unknown as Orivon
  return { files, dirs }
}

/** Collects what `watcher` emits, and resolves `settled` after a macrotask so a broadcast has landed. */
function collect (watcher: { on: (event: 'change', listener: (type: string, name: string) => void) => unknown }): Event[] {
  const seen: Event[] = []
  watcher.on('change', (type, name) => { seen.push([type, String(name)]) })
  return seen
}

const settle = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 20)) }
const write = async (fs: typeof import('../fs.js'), path: string, data = 'x'): Promise<void> => {
  await new Promise<void>((resolve, reject) => { fs.writeFile(path, data, (error) => (error === null ? resolve() : reject(error))) })
}

afterEach(() => {
  delete (globalThis as GlobalWithOrivon).orivon
  delete (globalThis as unknown as Record<symbol, unknown>)[FORK_LIVENESS_SYMBOL]
  vi.resetModules()
})

describe('fs.watch on a directory', () => {
  it('reports a created file as rename then change, and a rewrite as change', async () => {
    installFakeOrivon()
    const fs = await import('../fs.js')
    const watcher = fs.watch('users', { persistent: false })
    const seen = collect(watcher)
    await write(fs, 'users/a.json')
    await settle()
    expect(seen).toEqual([['rename', 'a.json'], ['change', 'a.json']])
    seen.length = 0
    await write(fs, 'users/a.json', 'y')
    await settle()
    expect(seen).toEqual([['change', 'a.json']])
    watcher.close()
  })

  it('reports a removed file, a made directory and a rename as rename', async () => {
    const { files } = installFakeOrivon()
    files.set('users/gone.json', new Uint8Array())
    files.set('users/old.json', new Uint8Array())
    const fs = await import('../fs.js')
    const watcher = fs.watch('users', { persistent: false })
    const seen = collect(watcher)
    await new Promise<void>((resolve) => { fs.unlink('users/gone.json', () => { resolve() }) })
    await new Promise<void>((resolve) => { fs.mkdir('users/sub', () => { resolve() }) })
    await new Promise<void>((resolve) => { fs.rename('users/old.json', 'users/new.json', () => { resolve() }) })
    await settle()
    expect(seen).toEqual([['rename', 'gone.json'], ['rename', 'sub'], ['rename', 'old.json'], ['rename', 'new.json']])
    watcher.close()
  })

  it('does not report a deeper path unless recursive, and reports it relative to the watched directory', async () => {
    const { dirs } = installFakeOrivon()
    dirs.add('users/deep')
    const fs = await import('../fs.js')
    const shallow = fs.watch('users', { persistent: false })
    const deep = fs.watch('users', { persistent: false, recursive: true })
    const shallowSeen = collect(shallow)
    const deepSeen = collect(deep)
    await write(fs, 'users/deep/b.json')
    await write(fs, 'other.json')
    await settle()
    expect(shallowSeen).toEqual([])
    expect(deepSeen).toEqual([['rename', 'deep/b.json'], ['change', 'deep/b.json']])
    shallow.close()
    deep.close()
  })

  it('takes a listener as the second or third argument, and buffer filenames on request', async () => {
    installFakeOrivon()
    const fs = await import('../fs.js')
    const names: unknown[] = []
    const one = fs.watch('users', { persistent: false }, (_type, name) => { names.push(name) })
    const two = fs.watch('users', { persistent: false, encoding: 'buffer' }, (_type, name) => { names.push(name) })
    await write(fs, 'users/c.json')
    await settle()
    expect(names).toContain('c.json')
    expect(names.some((name) => typeof name !== 'string' && String(name) === 'c.json')).toBe(true)
    one.close()
    two.close()
  })
})

describe('fs.watch on a file', () => {
  it('sees its own writes, and nothing about a sibling', async () => {
    const { files } = installFakeOrivon()
    files.set('packages.json', new Uint8Array())
    const fs = await import('../fs.js')
    const watcher = fs.watch('packages.json', { persistent: false })
    const seen = collect(watcher)
    await write(fs, 'other.json')
    await write(fs, 'packages.json')
    await settle()
    expect(seen).toEqual([['change', 'packages.json']])
    watcher.close()
  })

  it('a write through a file handle is a change, and a creating open is a rename', async () => {
    installFakeOrivon()
    const fs = await import('../fs.js')
    const watcher = fs.watch('users', { persistent: false })
    const seen = collect(watcher)
    const handle = await fs.promises.open('users/h.json', 'w')
    await handle.write(new Uint8Array([1]), 0, 1)
    await handle.close()
    await settle()
    expect(seen).toEqual([['rename', 'h.json'], ['change', 'h.json']])
    watcher.close()
  })
})

describe('FSWatcher', () => {
  it('a missing path throws ENOENT, as Node does', async () => {
    installFakeOrivon()
    const fs = await import('../fs.js')
    expect(() => fs.watch('nope')).toThrowError(expect.objectContaining({ code: 'ENOENT', syscall: 'watch' }) as Error)
  })

  it('close stops events, emits close once, and is idempotent', async () => {
    installFakeOrivon()
    const fs = await import('../fs.js')
    const watcher = fs.watch('users', { persistent: false })
    const seen = collect(watcher)
    let closed = 0
    watcher.on('close', () => { closed++ })
    watcher.close()
    watcher.close()
    await write(fs, 'users/z.json')
    await settle()
    expect(seen).toEqual([])
    expect(closed).toBe(1)
  })

  it('an aborted signal closes it', async () => {
    installFakeOrivon()
    const fs = await import('../fs.js')
    const controller = new AbortController()
    const watcher = fs.watch('users', { persistent: false, signal: controller.signal })
    const closed = new Promise<void>((resolve) => { watcher.on('close', () => { resolve() }) })
    controller.abort()
    await closed
  })

  it('a persistent watcher keeps a forked child alive until unref or close; persistent: false does not', async () => {
    installFakeOrivon()
    const liveness = { refs: 0, ref () { this.refs++ }, unref () { this.refs-- } }
    ;(globalThis as unknown as Record<symbol, unknown>)[FORK_LIVENESS_SYMBOL] = liveness
    const fs = await import('../fs.js')
    const quiet = fs.watch('users', { persistent: false })
    expect(liveness.refs).toBe(0)
    const persistent = fs.watch('users')
    expect(liveness.refs).toBe(1)
    persistent.unref()
    expect(liveness.refs).toBe(0)
    persistent.ref()
    persistent.ref()
    expect(liveness.refs).toBe(1)
    persistent.close()
    expect(liveness.refs).toBe(0)
    quiet.close()
  })

  it('reports a write another context of the app made, over the BroadcastChannel', async () => {
    installFakeOrivon()
    const watchingFs = await import('../fs.js')
    const watcher = watchingFs.watch('users', { persistent: false })
    const seen = collect(watcher)
    vi.resetModules()
    const writingFs = await import('../fs.js')
    // A context learns who is watching from a reply to its first announcement.
    await write(writingFs, 'warmup.json')
    await settle()
    await write(writingFs, 'users/remote.json')
    await settle()
    expect(seen).toEqual([['rename', 'remote.json'], ['change', 'remote.json']])
    watcher.close()
  })
})

describe('what a context tells the others', () => {
  /** The notices and counts every context posts, read off the channel as they are sent. */
  function posted (): { fs: () => string[], watching: () => Array<{ from: string, count: number }> } {
    const sent: Array<{ t: string, path?: string, from?: string, count?: number }> = []
    const post = BroadcastChannel.prototype.postMessage
    vi.spyOn(BroadcastChannel.prototype, 'postMessage').mockImplementation(function (this: BroadcastChannel, message: unknown) { sent.push(message as never); post.call(this, message) })
    return {
      fs: () => sent.filter((message) => message.t === 'fs').map((message) => message.path as string),
      watching: () => sent.filter((message) => message.t === 'watching').map((message) => ({ from: message.from as string, count: message.count as number }))
    }
  }

  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('does not post a write once it has had time to hear of every watcher and none exists', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    installFakeOrivon()
    const sent = posted()
    const fs = await import('../fs.js')
    await write(fs, 'early.json')
    expect(sent.fs()).toContain('early.json')
    vi.setSystemTime(Date.now() + 60_000)
    await write(fs, 'late.json')
    await settle()
    expect(sent.fs()).not.toContain('late.json')
  })

  it('still reaches a watcher that subscribes after the writer stopped posting', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    installFakeOrivon()
    const writingFs = await import('../fs.js')
    await write(writingFs, 'warmup.json')
    vi.setSystemTime(Date.now() + 60_000)
    vi.resetModules()
    const watchingFs = await import('../fs.js')
    const watcher = watchingFs.watch('users', { persistent: false })
    const seen = collect(watcher)
    await settle()
    await write(writingFs, 'users/after.json')
    await settle()
    expect(seen.map(([, name]) => name)).toContain('after.json')
    watcher.close()
  })

  it('a watching context repeats its count, and a count that is not repeated lapses', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    installFakeOrivon()
    const sent = posted()
    const fs = await import('../fs.js')
    const watcher = fs.watch('users', { persistent: false })
    const before = sent.watching().length
    await vi.advanceTimersByTimeAsync(12_000)
    expect(sent.watching().length).toBeGreaterThan(before)
    watcher.close()
    const afterClose = sent.watching().length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sent.watching().length).toBe(afterClose)

    // A context that died without saying so: its one count is all that was ever heard.
    vi.setSystemTime(Date.now() + 20_000)
    const ghost = new BroadcastChannel('orivon.fs.watch')
    ghost.postMessage({ t: 'watching', from: 'ghost', count: 1 })
    await settle()
    await write(fs, 'while-the-ghost-is-fresh.json')
    expect(sent.fs()).toContain('while-the-ghost-is-fresh.json')
    vi.setSystemTime(Date.now() + 60_000)
    await write(fs, 'after-the-ghost-lapsed.json')
    await settle()
    ghost.close()
    expect(sent.fs()).not.toContain('after-the-ghost-lapsed.json')
  })
})

describe('fs.promises.watch', () => {
  it('yields events until the loop is left', async () => {
    installFakeOrivon()
    const fs = await import('../fs.js')
    const events: unknown[] = []
    const loop = (async () => {
      for await (const event of fs.promises.watch('users', { persistent: false })) {
        events.push(event)
        if (events.length === 2) break
      }
    })()
    await settle()
    await write(fs, 'users/p.json')
    await loop
    expect(events).toEqual([{ eventType: 'rename', filename: 'p.json' }, { eventType: 'change', filename: 'p.json' }])
  })

  it('ends by rejecting with AbortError when its signal aborts', async () => {
    installFakeOrivon()
    const fs = await import('../fs.js')
    const controller = new AbortController()
    const loop = (async () => { for await (const _event of fs.promises.watch('users', { persistent: false, signal: controller.signal })) { /* none */ } })()
    await settle()
    controller.abort()
    await expect(loop).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('watchFile', () => {
  it('still refuses by name', async () => {
    installFakeOrivon()
    const fs = await import('../fs.js')
    expect(() => (fs.default as unknown as Record<string, () => void>).watchFile!()).toThrow(/fs\.watchFile/)
  })
})
