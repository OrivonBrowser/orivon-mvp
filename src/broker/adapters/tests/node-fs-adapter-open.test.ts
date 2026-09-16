import { statSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { nodeFs } from '../node-fs-adapter.js'

// `nodeFs(...).open` -- the real fd-backed half of orivon.fs.open
// (fs-capability.ts's own createFsCapability parks it there; this is the
// raw-I/O layer underneath, same split as readFile/writeFile/mkdir/etc. in
// node-fs-adapter.test.ts). Every test here opens a REAL file under a real
// temp directory -- confinement, the grant check and the handle table are
// fs-capability.test.ts's and handles.test.ts's job; this file only proves
// the descriptor this function returns actually does real I/O correctly.

const APP = 'https://app.example'

async function tempRoot (): Promise<ReturnType<typeof nodeFs>> {
  const userData = await mkdtemp(join(tmpdir(), 'orivon-nodefs-open-'))
  return nodeFs(userData)
}

describe('nodeFs(...).open -- positional read/write, no implicit cursor', () => {
  it('write at an explicit position then read it back at that same position', async () => {
    const fs = await tempRoot()
    const path = join(fs.rootFor(APP), 'piece.bin')
    const opened = await fs.open(path, 'w+')

    const written = await opened.write({ position: 100, data: new Uint8Array([9, 8, 7]) })

    expect(written).toBe(3)
    const back = await opened.read({ position: 100, length: 3 })
    expect(Array.from(back)).toEqual([9, 8, 7])
    await opened.destroy('closed')
  })

  it('writes out of order (piece N before piece N-1) land at their own offsets, not appended', async () => {
    // The contract's own worked example: piece N is written at N * pieceLength,
    // not appended sequentially. Writing piece 1 before piece 0 must not
    // shift piece 0's eventual bytes.
    const fs = await tempRoot()
    const path = join(fs.rootFor(APP), 'pieces.bin')
    const opened = await fs.open(path, 'w+')
    const pieceLength = 4

    await opened.write({ position: pieceLength, data: new Uint8Array([1, 1, 1, 1]) })
    await opened.write({ position: 0, data: new Uint8Array([0, 0, 0, 0]) })

    expect(Array.from(await opened.read({ position: 0, length: pieceLength }))).toEqual([0, 0, 0, 0])
    expect(Array.from(await opened.read({ position: pieceLength, length: pieceLength }))).toEqual([1, 1, 1, 1])
    await opened.destroy('closed')
  })

  it('read short-reads at EOF instead of padding the result', async () => {
    const fs = await tempRoot()
    const path = join(fs.rootFor(APP), 'short.bin')
    const opened = await fs.open(path, 'w+')
    await opened.write({ position: 0, data: new Uint8Array([1, 2, 3]) })

    const back = await opened.read({ position: 0, length: 100 })

    expect(back.byteLength).toBe(3)
    expect(Array.from(back)).toEqual([1, 2, 3])
    await opened.destroy('closed')
  })

  it('read at EOF returns a zero-length array, not an error', async () => {
    const fs = await tempRoot()
    const path = join(fs.rootFor(APP), 'empty.bin')
    const opened = await fs.open(path, 'w+')

    const back = await opened.read({ position: 0, length: 10 })

    expect(back.byteLength).toBe(0)
    await opened.destroy('closed')
  })
})

describe('nodeFs(...).open -- stat/truncate/sync', () => {
  it('stat reports the real size, isFile and mtimeMs through the open handle', async () => {
    const fs = await tempRoot()
    const path = join(fs.rootFor(APP), 'stat.bin')
    const opened = await fs.open(path, 'w+')
    await opened.write({ position: 0, data: new Uint8Array([1, 2, 3, 4]) })

    const stat = await opened.stat()

    expect(stat.size).toBe(4)
    expect(stat.isFile).toBe(true)
    expect(stat.isDirectory).toBe(false)
    expect(stat.mtimeMs).toBeGreaterThan(0)
    await opened.destroy('closed')
  })

  it('truncate shrinks the file; a read past the new end short-reads to nothing', async () => {
    const fs = await tempRoot()
    const path = join(fs.rootFor(APP), 'trunc.bin')
    const opened = await fs.open(path, 'w+')
    await opened.write({ position: 0, data: new Uint8Array([1, 2, 3, 4, 5]) })

    await opened.truncate(2)

    expect((await opened.stat()).size).toBe(2)
    expect((await opened.read({ position: 0, length: 10 })).byteLength).toBe(2)
    await opened.destroy('closed')
  })

  it('truncate can also extend the file, zero-filling the new region', async () => {
    const fs = await tempRoot()
    const path = join(fs.rootFor(APP), 'extend.bin')
    const opened = await fs.open(path, 'w+')
    await opened.write({ position: 0, data: new Uint8Array([1, 2]) })

    await opened.truncate(5)

    const back = await opened.read({ position: 0, length: 5 })
    expect(Array.from(back)).toEqual([1, 2, 0, 0, 0])
    await opened.destroy('closed')
  })

  it('sync resolves without throwing against a real fd', async () => {
    const fs = await tempRoot()
    const path = join(fs.rootFor(APP), 'sync.bin')
    const opened = await fs.open(path, 'w+')
    await opened.write({ position: 0, data: new Uint8Array([1]) })

    await expect(opened.sync()).resolves.toBeUndefined()
    await opened.destroy('closed')
  })
})

describe('nodeFs(...).open -- readable()/writable() are real WHATWG streams over the same fd', () => {
  it('writable() at an explicit start writes there, not at the ambient fd position', async () => {
    // NEVER omit `start` when building the underlying Node stream -- Node
    // falls back to the shared, kernel-tracked fd offset when it is left
    // undefined, which is exactly the implicit-cursor hazard this handle's
    // own contract (contracts/handles.ts) exists to rule out. This test
    // fails if that regresses back to `start: opts?.start` without the `?? 0`.
    const fs = await tempRoot()
    const path = join(fs.rootFor(APP), 'writable-start.bin')
    const opened = await fs.open(path, 'w+')

    const writer = opened.writable({ start: 3 }).getWriter()
    await writer.write(new Uint8Array([9, 9]))
    await writer.close()

    const back = await opened.read({ position: 3, length: 2 })
    expect(Array.from(back)).toEqual([9, 9])
    await opened.destroy('closed')
  })

  it('writable() with no opts starts at 0, matching the contract\'s documented default', async () => {
    const fs = await tempRoot()
    const path = join(fs.rootFor(APP), 'writable-default.bin')
    const opened = await fs.open(path, 'w+')

    const writer = opened.writable().getWriter()
    await writer.write(new Uint8Array([5, 5, 5]))
    await writer.close()

    expect(Array.from(await opened.read({ position: 0, length: 3 }))).toEqual([5, 5, 5])
    await opened.destroy('closed')
  })

  it('readable() over a [start, end) range yields exactly that slice', async () => {
    const fs = await tempRoot()
    const path = join(fs.rootFor(APP), 'readable-range.bin')
    const opened = await fs.open(path, 'w+')
    await opened.write({ position: 0, data: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) })

    const reader = opened.readable({ start: 2, end: 5 }).getReader()
    const chunks: number[] = []
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      chunks.push(...Array.from(value))
    }

    // [start, end) is exclusive of `end`, matching the contract's own doc.
    expect(chunks).toEqual([2, 3, 4])
    await opened.destroy('closed')
  })

  it('readable() with no opts streams the whole file from the start', async () => {
    const fs = await tempRoot()
    const path = join(fs.rootFor(APP), 'readable-whole.bin')
    const opened = await fs.open(path, 'w+')
    await opened.write({ position: 0, data: new Uint8Array([1, 2, 3]) })

    const reader = opened.readable().getReader()
    const chunks: number[] = []
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      chunks.push(...Array.from(value))
    }

    expect(chunks).toEqual([1, 2, 3])
    await opened.destroy('closed')
  })
})

describe('nodeFs(...).open -- destroy() teardown is conditional on the close reason (A84, applied to files)', () => {
  // Both tests below exploit the same trick node-adapters.ts's own drain
  // tests do NOT need for a socket (a real socket can be held open by a
  // paused peer): a real fs write() syscall cannot complete within one more
  // microtask turn -- it is dispatched to libuv's threadpool and reported
  // back on a LATER turn of the event loop -- so awaiting exactly one
  // microtask after firing the write (letting the WHATWG stream's own
  // internal queue dispatch it to the real Node stream, without which
  // destroy() would race ahead of even THAT and desync the two, per
  // "write after end") leaves the real write reliably still in flight when
  // destroy() runs a line later. Nothing here depends on disk SPEED.

  it('a flushing reason (\'closed\') lets an in-flight write land before the fd is released', async () => {
    const fs = await tempRoot()
    const path = join(fs.rootFor(APP), 'flush.bin')
    const opened = await fs.open(path, 'w+')
    const writer = opened.writable().getWriter()
    const chunk = new Uint8Array(64 * 1024).fill(7)

    // Not awaited: directly ending the raw Node stream from destroy() --
    // needed so a flush cannot hang on an app that never calls writer.close()
    // itself, matching destroySocket's own reasoning -- leaves this specific
    // WHATWG write() promise unsettled even once the byte it queued has
    // genuinely landed (confirmed directly: the raw stream's own 'finish'
    // event, and the data on disk, both arrive before destroy() resolves).
    // What destroy() actually promises is that the BYTES survive, which is
    // exactly what the assertion below checks.
    void writer.write(chunk)
    await Promise.resolve()
    await opened.destroy('closed')

    expect(statSync(path).size).toBe(chunk.byteLength)
  })

  it('an abrupt reason (\'revoked\') discards whatever was still queued, exactly like a socket\'s write queue', async () => {
    const fs = await tempRoot()
    const path = join(fs.rootFor(APP), 'discard.bin')
    const opened = await fs.open(path, 'w+')
    const writer = opened.writable().getWriter()
    const chunk = new Uint8Array(64 * 1024).fill(7)

    const pending = writer.write(chunk)
    await Promise.resolve()
    await opened.destroy('revoked')
    await pending.catch(() => {})

    expect(statSync(path).size).toBeLessThan(chunk.byteLength)
  })

  // Found running the FULL suite, not this file alone: destroying the raw
  // write stream abruptly bypasses Writable.toWeb's own graceful-close
  // bookkeeping, which then raises ERR_STREAM_PREMATURE_CLOSE as a real
  // 'error' event on that raw stream. An EventEmitter with zero 'error'
  // listeners THROWS -- on this path, that crashes the whole Electron main
  // process, not merely this one write. Reproduced directly here (not left
  // to show up as an unrelated-looking flake three tests later) by arming
  // process-level listeners and giving the delayed internal error a real
  // macrotask to fire on, matching where it was actually observed escaping.
  it('an abrupt reason never raises an unhandled process-level error, even on a delayed tick', async () => {
    const fs = await tempRoot()
    const path = join(fs.rootFor(APP), 'no-crash.bin')
    const opened = await fs.open(path, 'w+')
    const writer = opened.writable().getWriter()
    const chunk = new Uint8Array(64 * 1024).fill(7)
    const escaped: unknown[] = []
    const onUncaught = (error: unknown): void => { escaped.push(error) }
    process.on('uncaughtException', onUncaught)
    process.on('unhandledRejection', onUncaught)

    try {
      void writer.write(chunk)
      await Promise.resolve()
      await opened.destroy('revoked')
      // A real macrotask, not another microtask -- the premature-close
      // error surfaces from `end-of-stream`'s own internal listener, which
      // Node schedules via `process.nextTick`/a later turn, not inline with
      // destroy() itself (confirmed by it escaping AFTER this test had
      // already returned, the first time this was found).
      await new Promise((resolve) => { setImmediate(resolve) })
    } finally {
      process.off('uncaughtException', onUncaught)
      process.off('unhandledRejection', onUncaught)
    }

    expect(escaped).toEqual([])
  })

  it('destroy() closes the fd -- a read attempted afterwards fails rather than succeeding on a leaked descriptor', async () => {
    const fs = await tempRoot()
    const path = join(fs.rootFor(APP), 'afterclose.bin')
    const opened = await fs.open(path, 'w+')
    await opened.write({ position: 0, data: new Uint8Array([1]) })

    await opened.destroy('closed')

    await expect(opened.read({ position: 0, length: 1 })).rejects.toBeTruthy()
  })
})
