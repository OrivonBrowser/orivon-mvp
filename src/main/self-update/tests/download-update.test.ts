import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearPending, downloadUpdate, idleBounded } from '../download-update.js'
import type { FetchLike } from '../download-update.js'
import { WRONG_HASH } from '../download-verify.js'

const content = new TextEncoder().encode('package bytes')
const entry = { name: 'Orivon-1.2.0-x86_64.AppImage', size: content.length, sha256: createHash('sha256').update(content).digest('hex') }
let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orivon-dl-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const streamOf = (...parts: Uint8Array[]): ReadableStream<Uint8Array> => new ReadableStream({
  start (controller) { for (const part of parts) controller.enqueue(part); controller.close() }
})
const serving = (response: () => Response): FetchLike => async () => response()
const run = async (fetch: FetchLike, progress: (n: number, total: number) => void = () => {}): Promise<string> =>
  await downloadUpdate({ fetch, url: 'https://example.test/p', dir, file: entry, progress })

describe('downloadUpdate', () => {
  it('writes the package under its own name once size and hash agree, and leaves no part file', async () => {
    const seen: Array<[number, number]> = []
    const path = await run(serving(() => new Response(streamOf(content.slice(0, 4), content.slice(4)))), (n, total) => { seen.push([n, total]) })
    expect(path).toBe(join(dir, entry.name))
    expect(readFileSync(path)).toEqual(Buffer.from(content))
    expect(readdirSync(dir)).toEqual([entry.name])
    expect(seen).toEqual([[4, content.length], [content.length, content.length]])
  })

  it('refuses and removes a download whose hash differs', async () => {
    const wrong = new TextEncoder().encode('package bytez')
    await expect(run(serving(() => new Response(streamOf(wrong))))).rejects.toThrow(WRONG_HASH)
    expect(readdirSync(dir)).toEqual([])
  })

  it('refuses an answer that is not a success, or has no body', async () => {
    await expect(run(serving(() => new Response('no', { status: 404 })))).rejects.toThrow(/404/)
    await expect(run(serving(() => new Response(null, { status: 200 })))).rejects.toThrow(/no data/)
    expect(readdirSync(dir)).toEqual([])
  })

  it('says a request that failed to connect could not be completed, and leaves nothing', async () => {
    await expect(run(async () => { throw new TypeError('fetch failed') })).rejects.toThrow('fetch failed')
    expect(readdirSync(dir)).toEqual([])
  })

  it('clears what an earlier download left before it starts', async () => {
    writeFileSync(join(dir, 'old.AppImage'), 'x')
    writeFileSync(join(dir, 'old.AppImage.part'), 'x')
    await run(serving(() => new Response(streamOf(content))))
    expect(readdirSync(dir)).toEqual([entry.name])
  })
})

describe('clearPending', () => {
  it('empties the folder and does not mind that it is missing', async () => {
    writeFileSync(join(dir, 'a'), 'x')
    await clearPending(dir)
    expect(readdirSync(dir)).toEqual([])
    await clearPending(join(dir, 'missing'))
    expect(existsSync(join(dir, 'missing'))).toBe(false)
  })
})

describe('idleBounded', () => {
  it('ends the read with an error and cancels the connection when no byte arrives for the limit', async () => {
    let aborted = false
    const silent = new ReadableStream<Uint8Array>({ start () {} })
    const read = async (): Promise<void> => { for await (const chunk of idleBounded(silent, 20, () => { aborted = true })) void chunk }
    await expect(read()).rejects.toThrow(/stalled/)
    expect(aborted).toBe(true)
  })

  it('never ends a download that keeps sending, however long it takes in all', async () => {
    let sent = 0
    const slow = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        sent += 1
        if (sent === 8) controller.close()
        else controller.enqueue(new Uint8Array(1))
      }
    })
    let received = 0
    for await (const chunk of idleBounded(slow, 60, () => {})) received += chunk.length
    expect(received).toBe(7)
  })
})
