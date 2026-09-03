import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addBookmark,
  BookmarkStore,
  hasBookmark,
  parseBookmarksFile,
  removeBookmark,
  serializeBookmarksFile,
  WRITE_DEBOUNCE_MS,
  type Bookmark
} from './bookmarks.js'

// BookmarkStore imports writeFile straight from node:fs/promises, so mocking
// the module is the only way to hold one specific write open from outside
// and prove flushPendingWrite() genuinely waits for it. `fsGate` is declared
// through vi.hoisted because vi.mock's factory runs before the rest of this
// file and would otherwise not see it. Every other fs/promises export, and
// writeFile itself once nothing is gating it, passes straight through.
//
// `failNextWith`: lets a test make the next writeFile call reject instead of
// landing, to prove flushPendingWrite() reports a genuine failure instead of
// resolving as though the write succeeded.
const fsGate = vi.hoisted(() => ({
  release: null as Promise<void> | null,
  writeFileCallCount: 0,
  failNextWith: null as Error | null
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    writeFile: async (file: string, data: string, encoding: BufferEncoding): Promise<void> => {
      fsGate.writeFileCallCount++
      const gate = fsGate.release
      if (gate !== null) {
        fsGate.release = null
        await gate
      }
      const failure = fsGate.failNextWith
      if (failure !== null) {
        fsGate.failNextWith = null
        throw failure
      }
      await actual.writeFile(file, data, encoding)
    }
  }
})

describe('addBookmark', () => {
  it('appends a new entry', () => {
    const result = addBookmark([], { url: 'https://a.example/', title: 'A' })
    expect(result).toEqual([{ url: 'https://a.example/', title: 'A' }])
  })

  it('replaces an existing entry for the same URL, moving it to the end', () => {
    const list: Bookmark[] = [
      { url: 'https://a.example/', title: 'A' },
      { url: 'https://b.example/', title: 'B' }
    ]
    const result = addBookmark(list, { url: 'https://a.example/', title: 'A renamed' })
    expect(result).toEqual([
      { url: 'https://b.example/', title: 'B' },
      { url: 'https://a.example/', title: 'A renamed' }
    ])
  })
})

describe('removeBookmark', () => {
  it('drops the matching URL and leaves the rest', () => {
    const list: Bookmark[] = [
      { url: 'https://a.example/', title: 'A' },
      { url: 'https://b.example/', title: 'B' }
    ]
    expect(removeBookmark(list, 'https://a.example/')).toEqual([{ url: 'https://b.example/', title: 'B' }])
  })

  it('is a no-op when the URL is not bookmarked', () => {
    const list: Bookmark[] = [{ url: 'https://a.example/', title: 'A' }]
    expect(removeBookmark(list, 'https://nowhere.example/')).toEqual(list)
  })
})

describe('hasBookmark', () => {
  it('reports true only for a URL present in the list', () => {
    const list: Bookmark[] = [{ url: 'https://a.example/', title: 'A' }]
    expect(hasBookmark(list, 'https://a.example/')).toBe(true)
    expect(hasBookmark(list, 'https://b.example/')).toBe(false)
  })
})

describe('parseBookmarksFile', () => {
  it('round-trips what serializeBookmarksFile writes', () => {
    const list: Bookmark[] = [{ url: 'https://a.example/', title: 'A' }]
    expect(parseBookmarksFile(serializeBookmarksFile(list))).toEqual(list)
  })

  it('yields an empty list for invalid JSON', () => {
    expect(parseBookmarksFile('{not json')).toEqual([])
  })

  it('yields an empty list when the JSON is not an array', () => {
    expect(parseBookmarksFile('{"url":"https://a.example/"}')).toEqual([])
  })

  it('drops entries missing a url or title', () => {
    const raw = JSON.stringify([
      { url: 'https://a.example/', title: 'A' },
      { url: 'https://b.example/' },
      { title: 'no url' },
      { url: 123, title: 'wrong type' }
    ])
    expect(parseBookmarksFile(raw)).toEqual([{ url: 'https://a.example/', title: 'A' }])
  })

  // Security-critical: the file is user-writable, and a stored
  // javascript:/data:/file: URL would be persisted XSS into this
  // privileged chrome view the moment the bar renders it.
  it('rejects entries with a dangerous scheme, same rule as the omnibox', () => {
    const raw = JSON.stringify([
      { url: 'javascript:alert(1)', title: 'evil' },
      { url: 'https://a.example/', title: 'fine' }
    ])
    expect(parseBookmarksFile(raw)).toEqual([{ url: 'https://a.example/', title: 'fine' }])
  })
})

describe('BookmarkStore', () => {
  let dir: string
  let filePath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orivon-bookmarks-'))
    filePath = join(dir, 'nested', 'bookmarks.json')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
    fsGate.release = null
    fsGate.writeFileCallCount = 0
    fsGate.failNextWith = null
  })

  it('starts empty when the file does not exist yet (first launch)', async () => {
    const store = new BookmarkStore(filePath)
    await store.load()
    expect(store.getAll()).toEqual([])
  })

  it('starts empty rather than throwing when the file is corrupt', async () => {
    await mkdirAndWrite(filePath, 'not json at all')
    const store = new BookmarkStore(filePath)
    await expect(store.load()).resolves.toBeUndefined()
    expect(store.getAll()).toEqual([])
  })

  it('add() is rejected for a dangerous scheme and does not change the list', () => {
    const store = new BookmarkStore(filePath)
    store.add({ url: 'javascript:alert(1)', title: 'evil' })
    expect(store.getAll()).toEqual([])
  })

  it('add() then remove() round-trips through has()', () => {
    const store = new BookmarkStore(filePath)
    expect(store.has('https://a.example/')).toBe(false)
    store.add({ url: 'https://a.example/', title: 'A' })
    expect(store.has('https://a.example/')).toBe(true)
    store.remove('https://a.example/')
    expect(store.has('https://a.example/')).toBe(false)
  })

  it('debounces writes and persists the final state to disk, creating parent directories', async () => {
    const store = new BookmarkStore(filePath)
    store.add({ url: 'https://a.example/', title: 'A' })
    store.add({ url: 'https://b.example/', title: 'B' })
    // Nothing written yet -- still inside the debounce window.
    await expect(readFile(filePath, 'utf8')).rejects.toThrow()

    // Waits for the actual write to settle instead of guessing how long the
    // debounce plus disk I/O will take -- a fixed guess is what made this
    // test flaky under load (ENOENT reading the file too early).
    await store.flushPendingWrite()

    const onDisk = parseBookmarksFile(await readFile(filePath, 'utf8'))
    expect(onDisk).toEqual([
      { url: 'https://a.example/', title: 'A' },
      { url: 'https://b.example/', title: 'B' }
    ])
  })

  it('flushPendingWrite settles even when a second change arrives before the debounced write has fired', async () => {
    const store = new BookmarkStore(filePath)
    store.add({ url: 'https://a.example/', title: 'A' })
    const flushed = store.flushPendingWrite()
    store.add({ url: 'https://b.example/', title: 'B' })

    // Short explicit timeout: a caller holding this promise must never wait
    // forever just because another change landed before the write fired. If
    // this regresses, it should fail fast here rather than hang the suite.
    await expect(flushed).resolves.toBeUndefined()

    const onDisk = parseBookmarksFile(await readFile(filePath, 'utf8'))
    expect(onDisk).toEqual([
      { url: 'https://a.example/', title: 'A' },
      { url: 'https://b.example/', title: 'B' }
    ])
  }, 1000)

  it('does not resolve until a change made while the write is already in flight is also on disk', async () => {
    const store = new BookmarkStore(filePath)
    store.add({ url: 'https://a.example/', title: 'A' })

    let releaseFirstWrite: () => void = () => {}
    fsGate.release = new Promise((resolve) => { releaseFirstWrite = resolve })

    // Wait for the debounced write to actually start -- it is now blocked
    // on the gate above, i.e. genuinely in flight, not merely scheduled.
    await vi.waitFor(() => {
      expect(fsGate.writeFileCallCount).toBe(1)
    }, 1000)

    const flushed = store.flushPendingWrite()
    store.add({ url: 'https://b.example/', title: 'B' })
    releaseFirstWrite()

    await flushed

    const onDisk = parseBookmarksFile(await readFile(filePath, 'utf8'))
    expect(onDisk).toEqual([
      { url: 'https://a.example/', title: 'A' },
      { url: 'https://b.example/', title: 'B' }
    ])
  }, 2000)

  // Reproduces the clobber a three-persona review found in this branch's
  // first attempt: a first write that is still in flight when a second
  // change arrives must never be allowed to land AFTER a write reflecting
  // that second change -- if it does, the second change is silently lost,
  // and flushPendingWrite() must not have already told the caller it was
  // safe.
  it('does not resolve while a slow first write could still land after a fresher one and clobber it', async () => {
    const store = new BookmarkStore(filePath)
    store.add({ url: 'https://a.example/', title: 'A' })

    let releaseFirstWrite: () => void = () => {}
    fsGate.release = new Promise((resolve) => { releaseFirstWrite = resolve })

    // Wait for the debounced write to actually start -- it is now blocked
    // on the gate above, genuinely in flight rather than merely scheduled.
    await vi.waitFor(() => {
      expect(fsGate.writeFileCallCount).toBe(1)
    }, 1000)

    const flushed = store.flushPendingWrite()
    let settled = false
    void flushed.finally(() => { settled = true })

    store.add({ url: 'https://b.example/', title: 'B' })

    // Longer than one debounce window: enough time for a second, unblocked
    // write to start and land if the implementation lets one run
    // concurrently with the still-gated first write. A correct
    // implementation never starts that second write at all while the
    // first is in flight -- it waits and folds the change into the next
    // write instead.
    await new Promise((resolve) => setTimeout(resolve, WRITE_DEBOUNCE_MS + 200))
    expect(fsGate.writeFileCallCount).toBe(1)
    expect(settled).toBe(false)

    releaseFirstWrite()
    await flushed

    expect(settled).toBe(true)
    const onDisk = parseBookmarksFile(await readFile(filePath, 'utf8'))
    expect(onDisk).toEqual([
      { url: 'https://a.example/', title: 'A' },
      { url: 'https://b.example/', title: 'B' }
    ])
  }, 3000)

  it('flushPendingWrite() rejects after a write that genuinely failed, rather than resolving as if it landed', async () => {
    const store = new BookmarkStore(filePath)
    const failure = new Error('ENOSPC: no space left on device')
    fsGate.failNextWith = failure
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    store.add({ url: 'https://a.example/', title: 'A' })

    await expect(store.flushPendingWrite()).rejects.toBe(failure)
    expect(errorSpy).toHaveBeenCalled()

    errorSpy.mockRestore()
  }, 1000)

  it('resolves immediately, without throwing, when nothing has ever been scheduled', async () => {
    const store = new BookmarkStore(filePath)
    await expect(store.flushPendingWrite()).resolves.toBeUndefined()
  })

  it('resolves immediately once a previous write has fully settled, and still tracks the next one', async () => {
    const store = new BookmarkStore(filePath)
    store.add({ url: 'https://a.example/', title: 'A' })
    await store.flushPendingWrite()
    await expect(store.flushPendingWrite()).resolves.toBeUndefined()

    store.add({ url: 'https://b.example/', title: 'B' })
    await store.flushPendingWrite()

    const onDisk = parseBookmarksFile(await readFile(filePath, 'utf8'))
    expect(onDisk).toEqual([
      { url: 'https://a.example/', title: 'A' },
      { url: 'https://b.example/', title: 'B' }
    ])
  }, 1000)

  it('notifies onChange listeners on add and remove', () => {
    const store = new BookmarkStore(filePath)
    const calls: number[] = []
    store.onChange(() => calls.push(calls.length))
    store.add({ url: 'https://a.example/', title: 'A' })
    store.remove('https://a.example/')
    expect(calls).toEqual([0, 1])
  })
})

async function mkdirAndWrite (path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents, 'utf8')
}
