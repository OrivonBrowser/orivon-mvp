// fs.watch and fs.promises.watch, over the notices fs/notices.ts collects:
// a watcher sees only what was written through this shim, by this context or
// another of the same app. README.md's Design notes have the limits.

import { EventEmitter } from 'events'
import { Buffer } from 'buffer'
import { getOrivon } from '../orivon-global.js'
import { FORK_LIVENESS_SYMBOL } from '../worker/symbols.js'
import { existsSyncCore } from './core-sync.js'
import { confineSync, fsError, type PathLike } from './paths.js'
import { normalizeNoticePath, subscribe, type WatchKind } from './notices.js'

export interface WatchOptions {
  persistent?: boolean
  recursive?: boolean
  encoding?: string | null
  signal?: AbortSignal
}

export type WatchListener = (eventType: WatchKind, filename: string | Buffer) => void

interface Liveness { ref: () => void, unref: () => void }

function forkLiveness (): Liveness | undefined {
  return (globalThis as unknown as Record<symbol, Liveness | undefined>)[FORK_LIVENESS_SYMBOL]
}

/** The name an event carries, from `watched`'s point of view, or undefined when the changed path is not one this watcher covers. */
export function filenameFor (watched: string, changed: string, recursive: boolean): string | undefined {
  const parts = changed.split('/')
  const base = parts[parts.length - 1] ?? ''
  if (changed === watched) return base
  const parent = parts.slice(0, -1).join('/')
  if (parent === watched) return base
  if (recursive && (watched === '' || changed.startsWith(`${watched}/`))) return watched === '' ? changed : changed.slice(watched.length + 1)
  return undefined
}

export class FSWatcher extends EventEmitter {
  readonly #watched: string
  readonly #recursive: boolean
  readonly #buffer: boolean
  #unsubscribe: (() => void) | undefined
  #referenced = false
  #closed = false

  constructor (watched: string, options: WatchOptions) {
    super()
    this.#watched = watched
    this.#recursive = options.recursive === true
    this.#buffer = options.encoding === 'buffer'
    this.#unsubscribe = subscribe((path, kind) => {
      const filename = filenameFor(this.#watched, path, this.#recursive)
      if (filename !== undefined) this.emit('change', kind, this.#buffer ? Buffer.from(filename) : filename)
    })
    if (options.persistent !== false) this.ref()
    const { signal } = options
    if (signal !== undefined) {
      if (signal.aborted) queueMicrotask(() => { this.close() })
      else signal.addEventListener('abort', () => { this.close() }, { once: true })
    }
  }

  /** Keeps the forked child alive while the watcher is open, as Node's persistent watcher keeps its process. */
  ref (): this {
    if (!this.#referenced && !this.#closed) {
      this.#referenced = true
      forkLiveness()?.ref()
    }
    return this
  }

  unref (): this {
    if (this.#referenced) {
      this.#referenced = false
      forkLiveness()?.unref()
    }
    return this
  }

  close (): void {
    if (this.#closed) return
    this.unref()
    this.#closed = true
    this.#unsubscribe?.()
    this.#unsubscribe = undefined
    queueMicrotask(() => { this.emit('close') })
  }
}

function watchedPath (path: PathLike): string {
  const confined = normalizeNoticePath(confineSync(path, 'watch', 'fs.watch'))
  if (!existsSyncCore(path, (target) => getOrivon().fs.readFileSync(target))) {
    throw fsError('ENOENT', 'no such file or directory', 'watch', typeof path === 'string' ? path : confined)
  }
  return confined
}

export function watch (path: PathLike, listenerOrOptions?: WatchOptions | string | WatchListener | null, maybeListener?: WatchListener): FSWatcher {
  const listener = typeof listenerOrOptions === 'function' ? listenerOrOptions : maybeListener
  const options: WatchOptions = typeof listenerOrOptions === 'string'
    ? { encoding: listenerOrOptions }
    : (typeof listenerOrOptions === 'object' && listenerOrOptions !== null ? listenerOrOptions : {})
  const watcher = new FSWatcher(watchedPath(path), options)
  if (listener !== undefined) watcher.on('change', listener)
  return watcher
}

export interface WatchEvent { eventType: WatchKind, filename: string | Buffer }

/** fs.promises.watch: an async iterator of events until the signal aborts or the loop is left. */
export function watchPromise (path: PathLike, options: WatchOptions = {}): AsyncIterable<WatchEvent> {
  return {
    [Symbol.asyncIterator] (): AsyncIterator<WatchEvent> {
      const watcher = watch(path, options)
      const queue: WatchEvent[] = []
      let wake: (() => void) | undefined
      let done = false
      watcher.on('change', (eventType: WatchKind, filename: string | Buffer) => { queue.push({ eventType, filename }); wake?.() })
      watcher.on('close', () => { done = true; wake?.() })
      return {
        async next (): Promise<IteratorResult<WatchEvent>> {
          for (;;) {
            const event = queue.shift()
            if (event !== undefined) return { value: event, done: false }
            if (done) {
              if (options.signal?.aborted === true) throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' })
              return { value: undefined, done: true }
            }
            await new Promise<void>((resolve) => { wake = resolve })
          }
        },
        async return (): Promise<IteratorResult<WatchEvent>> {
          watcher.close()
          return { value: undefined, done: true }
        }
      }
    }
  }
}
