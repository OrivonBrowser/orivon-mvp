import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseBookmarksFile } from '../bookmark-file.js'
import { flattenUrls } from '../bookmark-tree.js'
import {
  BookmarkStore,
  MAX_STORED_FAVICON_CHARS,
  sanitizeStoredFavicon,
  WRITE_DEBOUNCE_MS,
  type Bookmark
} from '../bookmarks.js'

/** What bookmarks.json holds, as the flat list of pages the store's own `getAll` gives. */
function pagesOnDisk (raw: string): Bookmark[] {
  return flattenUrls(parseBookmarksFile(raw).tree).map(({ url, title, favicon }) => ({ url: url ?? '', title, favicon: favicon ?? null }))
}

// BookmarkStore writes through writeFileAtomicAsync (atomic-write.ts); mocking that module -- not
// node:fs/promises, which it no longer calls at the top level, only through its own open() file handle --
// is how a test holds one specific write open from outside and proves flushPendingWrite() genuinely waits
// for it. `fsGate` is declared through vi.hoisted because vi.mock's factory runs before the rest of this
// file and would otherwise not see it. Every other export, and writeFileAtomicAsync itself once nothing is
// gating it, passes straight through to the real implementation.
//
// `failNextWith`: lets a test make the next write reject instead of landing, simulating a failure inside
// writeFileAtomicAsync -- that it never touches the real path except by a completed rename is atomic-write.ts's
// own contract, proved directly in its own tests, not re-proved here.
const fsGate = vi.hoisted(() => ({
  release: null as Promise<void> | null,
  writeCallCount: 0,
  failNextWith: null as Error | null
}))

vi.mock('../../../broker/adapters/atomic-write.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../broker/adapters/atomic-write.js')>()
  return {
    ...actual,
    writeFileAtomicAsync: async (path: string, text: string): Promise<void> => {
      fsGate.writeCallCount++
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
      await actual.writeFileAtomicAsync(path, text)
    }
  }
})

describe('sanitizeStoredFavicon -- bookmarks.json is a user-writable file', () => {
  const tiny = 'data:image/png;base64,iVBORw0KGgo='

  it('accepts a data: image URL', () => {
    expect(sanitizeStoredFavicon(tiny)).toBe(tiny)
  })

  it('rejects a data: URL that is not an image -- a stored data:text/html must never reach an <img>', () => {
    expect(sanitizeStoredFavicon('data:text/html;base64,PHNjcmlwdD4=')).toBeNull()
  })

  it('rejects an http(s) URL -- a privileged view must never fetch an icon over the network', () => {
    expect(sanitizeStoredFavicon('https://evil.example/tracker.png')).toBeNull()
    expect(sanitizeStoredFavicon('http://a.example/favicon.ico')).toBeNull()
  })

  it('rejects anything past the size cap', () => {
    const huge = 'data:image/png;base64,' + 'A'.repeat(MAX_STORED_FAVICON_CHARS)
    expect(sanitizeStoredFavicon(huge)).toBeNull()
  })

  it('rejects a non-string', () => {
    expect(sanitizeStoredFavicon(undefined)).toBeNull()
    expect(sanitizeStoredFavicon(null)).toBeNull()
    expect(sanitizeStoredFavicon(42)).toBeNull()
    expect(sanitizeStoredFavicon({ toString: () => tiny })).toBeNull()
  })

  // bookmarks.json is untrusted input (this function's own doc comment):
  // the prefix and length checks alone would accept anything merely
  // LABELLED image/*, so a stored favicon goes through the same byte sniff
  // a network-fetched one does.
  it('rejects a data:image/* URL whose bytes are not actually a recognised image', () => {
    const notAnImage = `data:image/png;base64,${Buffer.from('just some text, not a png').toString('base64')}`
    expect(sanitizeStoredFavicon(notAnImage)).toBeNull()
  })

  it('accepts a real SVG stored under the image/svg+xml label', () => {
    const svg = `data:image/svg+xml;base64,${Buffer.from('<svg></svg>').toString('base64')}`
    expect(sanitizeStoredFavicon(svg)).toBe(svg)
  })

  it('relabels a stored icon by its bytes, so its label never disagrees with what it is', () => {
    const svgBytes = Buffer.from('<svg></svg>').toString('base64')
    expect(sanitizeStoredFavicon(`data:image/png;base64,${svgBytes}`)).toBe(`data:image/svg+xml;base64,${svgBytes}`)
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
    fsGate.writeCallCount = 0
    fsGate.failNextWith = null
  })

  describe('BookmarkStore.fillMissingFavicon -- the icon that arrives after the star', () => {
    const tiny = 'data:image/png;base64,iVBORw0KGgo='
    const other = 'data:image/gif;base64,R0lGODlhAQAB'

    it('fills in the icon for a bookmark saved without one', () => {
      const store = new BookmarkStore(filePath)
      store.add({ url: 'https://a.example/', title: 'A' })

      expect(store.fillMissingFavicon('https://a.example/', tiny)).toBe(true)
      expect(store.getAll()[0]?.favicon).toBe(tiny)
    })

    it('never overwrites an icon already stored -- the one captured at star time is the page the user chose', () => {
      const store = new BookmarkStore(filePath)
      store.add({ url: 'https://a.example/', title: 'A', favicon: tiny })

      expect(store.fillMissingFavicon('https://a.example/', other)).toBe(false)
      expect(store.getAll()[0]?.favicon).toBe(tiny)
    })

    it('is a no-op for a URL that is not bookmarked', () => {
      const store = new BookmarkStore(filePath)
      expect(store.fillMissingFavicon('https://nowhere.example/', tiny)).toBe(false)
    })

    it('refuses an icon that would not survive a reload anyway', () => {
      const store = new BookmarkStore(filePath)
      store.add({ url: 'https://a.example/', title: 'A' })

      expect(store.fillMissingFavicon('https://a.example/', 'https://evil.example/x.png')).toBe(false)
      expect(store.getAll()[0]?.favicon).toBeNull()
    })

    // window-state.ts calls this from INSIDE a state push, so a notification during the call would push state from
    // within a state push; the listeners hear of it just after, once however many icons were filled.
    it('tells the onChange listeners after the call, once, and persists', async () => {
      const store = new BookmarkStore(filePath)
      store.add({ url: 'https://a.example/', title: 'A' })
      await store.flushPendingWrite()

      const listener = vi.fn()
      store.onChange(listener)
      store.add({ url: 'https://b.example/', title: 'B' })
      listener.mockClear()
      expect(store.fillMissingFavicon('https://a.example/', tiny)).toBe(true)
      expect(store.fillMissingFavicon('https://b.example/', tiny)).toBe(true)
      expect(listener).not.toHaveBeenCalled()
      await Promise.resolve()
      expect(listener).toHaveBeenCalledTimes(1)

      await store.flushPendingWrite()
      const onDisk = pagesOnDisk(await readFile(filePath, 'utf8'))
      expect(onDisk[0]?.favicon).toBe(tiny)
    })
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

  it('reads the file once, so a second caller cannot replace an unflushed change', async () => {
    const store = new BookmarkStore(filePath)
    await store.load()
    store.add({ url: 'https://a.example/', title: 'A', favicon: null })

    await store.load()

    expect(store.getAll().map((b) => b.url)).toEqual(['https://a.example/'])
  })

  it('onChange returns its own removal', () => {
    const store = new BookmarkStore(filePath)
    const listener = vi.fn()
    const stop = store.onChange(listener)

    store.add({ url: 'https://a.example/', title: 'A', favicon: null })
    stop()
    store.add({ url: 'https://b.example/', title: 'B', favicon: null })

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('add() is rejected for a dangerous scheme and does not change the list', () => {
    const store = new BookmarkStore(filePath)
    store.add({ url: 'javascript:alert(1)', title: 'evil', favicon: null })
    expect(store.getAll()).toEqual([])
  })

  it('add() then remove() round-trips through has()', () => {
    const store = new BookmarkStore(filePath)
    expect(store.has('https://a.example/')).toBe(false)
    store.add({ url: 'https://a.example/', title: 'A', favicon: null })
    expect(store.has('https://a.example/')).toBe(true)
    store.remove('https://a.example/')
    expect(store.has('https://a.example/')).toBe(false)
  })

  it('debounces writes and persists the final state to disk, creating parent directories', async () => {
    const store = new BookmarkStore(filePath)
    store.add({ url: 'https://a.example/', title: 'A', favicon: null })
    store.add({ url: 'https://b.example/', title: 'B', favicon: null })
    // Nothing written yet -- still inside the debounce window.
    await expect(readFile(filePath, 'utf8')).rejects.toThrow()

    // Waits for the actual write to settle instead of guessing how long the
    // debounce plus disk I/O will take -- a fixed guess is what made this
    // test flaky under load (ENOENT reading the file too early).
    await store.flushPendingWrite()

    const onDisk = pagesOnDisk(await readFile(filePath, 'utf8'))
    expect(onDisk).toEqual([
      { url: 'https://a.example/', title: 'A', favicon: null },
      { url: 'https://b.example/', title: 'B', favicon: null }
    ])
  })

  // Every other test in this file goes through fsGate's wrapper around atomic-write.js -- a passthrough to
  // the real writeFileAtomicAsync whenever nothing is gating it, which every test above already is, but
  // none of them checks the one thing that module promises beyond "the change lands": that nothing of its
  // own is left in the directory once it has. This one does, driving the real writer with no gate involved.
  it('drives the real atomic writer end to end: flushPendingWrite() resolves only once the change is on disk, with no temp file left', async () => {
    const store = new BookmarkStore(filePath)
    store.add({ url: 'https://a.example/', title: 'A', favicon: null })

    await store.flushPendingWrite()

    expect(pagesOnDisk(await readFile(filePath, 'utf8'))).toEqual([
      { url: 'https://a.example/', title: 'A', favicon: null }
    ])
    expect(await readdir(dirname(filePath))).toEqual(['bookmarks.json'])
  })

  it('flushPendingWrite settles even when a second change arrives before the debounced write has fired', async () => {
    const store = new BookmarkStore(filePath)
    store.add({ url: 'https://a.example/', title: 'A', favicon: null })
    const flushed = store.flushPendingWrite()
    store.add({ url: 'https://b.example/', title: 'B', favicon: null })

    // Short explicit timeout: a caller holding this promise must never wait
    // forever just because another change landed before the write fired. If
    // this regresses, it should fail fast here rather than hang the suite.
    await expect(flushed).resolves.toBeUndefined()

    const onDisk = pagesOnDisk(await readFile(filePath, 'utf8'))
    expect(onDisk).toEqual([
      { url: 'https://a.example/', title: 'A', favicon: null },
      { url: 'https://b.example/', title: 'B', favicon: null }
    ])
  }, 1000)

  it('does not resolve until a change made while the write is already in flight is also on disk', async () => {
    const store = new BookmarkStore(filePath)
    store.add({ url: 'https://a.example/', title: 'A', favicon: null })

    let releaseFirstWrite: () => void = () => {}
    fsGate.release = new Promise((resolve) => { releaseFirstWrite = resolve })

    // Wait for the debounced write to actually start -- it is now blocked
    // on the gate above, i.e. genuinely in flight, not merely scheduled.
    await vi.waitFor(() => {
      expect(fsGate.writeCallCount).toBe(1)
    }, 1000)

    const flushed = store.flushPendingWrite()
    store.add({ url: 'https://b.example/', title: 'B', favicon: null })
    releaseFirstWrite()

    await flushed

    const onDisk = pagesOnDisk(await readFile(filePath, 'utf8'))
    expect(onDisk).toEqual([
      { url: 'https://a.example/', title: 'A', favicon: null },
      { url: 'https://b.example/', title: 'B', favicon: null }
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
    store.add({ url: 'https://a.example/', title: 'A', favicon: null })

    let releaseFirstWrite: () => void = () => {}
    fsGate.release = new Promise((resolve) => { releaseFirstWrite = resolve })

    // Wait for the debounced write to actually start -- it is now blocked
    // on the gate above, genuinely in flight rather than merely scheduled.
    await vi.waitFor(() => {
      expect(fsGate.writeCallCount).toBe(1)
    }, 1000)

    const flushed = store.flushPendingWrite()
    let settled = false
    void flushed.finally(() => { settled = true })

    store.add({ url: 'https://b.example/', title: 'B', favicon: null })

    // Longer than one debounce window: enough time for a second, unblocked
    // write to start and land if the implementation lets one run
    // concurrently with the still-gated first write. A correct
    // implementation never starts that second write at all while the
    // first is in flight -- it waits and folds the change into the next
    // write instead.
    await new Promise((resolve) => setTimeout(resolve, WRITE_DEBOUNCE_MS + 200))
    expect(fsGate.writeCallCount).toBe(1)
    expect(settled).toBe(false)

    releaseFirstWrite()
    await flushed

    expect(settled).toBe(true)
    const onDisk = pagesOnDisk(await readFile(filePath, 'utf8'))
    expect(onDisk).toEqual([
      { url: 'https://a.example/', title: 'A', favicon: null },
      { url: 'https://b.example/', title: 'B', favicon: null }
    ])
  }, 3000)

  it('flushPendingWrite() rejects after a write that genuinely failed, rather than resolving as if it landed', async () => {
    const store = new BookmarkStore(filePath)
    const failure = new Error('ENOSPC: no space left on device')
    fsGate.failNextWith = failure
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    store.add({ url: 'https://a.example/', title: 'A', favicon: null })

    await expect(store.flushPendingWrite()).rejects.toBe(failure)
    expect(errorSpy).toHaveBeenCalled()

    errorSpy.mockRestore()
  }, 1000)

  it('a write that fails leaves the previously persisted file intact, not truncated', async () => {
    const store = new BookmarkStore(filePath)
    store.add({ url: 'https://a.example/', title: 'A', favicon: null })
    await store.flushPendingWrite()
    const before = await readFile(filePath, 'utf8')

    const failure = new Error('ENOSPC: no space left on device')
    fsGate.failNextWith = failure
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    store.add({ url: 'https://b.example/', title: 'B', favicon: null })
    await expect(store.flushPendingWrite()).rejects.toBe(failure)

    expect(await readFile(filePath, 'utf8')).toBe(before)
    errorSpy.mockRestore()
  }, 2000)

  it('resolves immediately, without throwing, when nothing has ever been scheduled', async () => {
    const store = new BookmarkStore(filePath)
    await expect(store.flushPendingWrite()).resolves.toBeUndefined()
  })

  it('resolves immediately once a previous write has fully settled, and still tracks the next one', async () => {
    const store = new BookmarkStore(filePath)
    store.add({ url: 'https://a.example/', title: 'A', favicon: null })
    await store.flushPendingWrite()
    await expect(store.flushPendingWrite()).resolves.toBeUndefined()

    store.add({ url: 'https://b.example/', title: 'B', favicon: null })
    await store.flushPendingWrite()

    const onDisk = pagesOnDisk(await readFile(filePath, 'utf8'))
    expect(onDisk).toEqual([
      { url: 'https://a.example/', title: 'A', favicon: null },
      { url: 'https://b.example/', title: 'B', favicon: null }
    ])
  }, 2000)

  it('notifies onChange listeners on add and remove', () => {
    const store = new BookmarkStore(filePath)
    const calls: number[] = []
    store.onChange(() => calls.push(calls.length))
    store.add({ url: 'https://a.example/', title: 'A', favicon: null })
    store.remove('https://a.example/')
    expect(calls).toEqual([0, 1])
  })
})

async function mkdirAndWrite (path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents, 'utf8')
}
