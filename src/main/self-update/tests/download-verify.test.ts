import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { consumeDownload, TOO_LARGE, WRONG_HASH, WRONG_SIZE } from '../download-verify.js'

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)
const sha = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')
async function * pieces (...parts: Uint8Array[]): AsyncGenerator<Uint8Array> { for (const part of parts) yield part }
const whole = bytes('hello update')

describe('consumeDownload', () => {
  it('passes a download that is the listed size and hash, piece by piece, reporting progress', async () => {
    const written: number[] = []
    const seen: number[] = []
    const verdict = await consumeDownload(pieces(whole.slice(0, 5), whole.slice(5)), { size: whole.length, sha256: sha(whole) }, async (chunk) => { written.push(chunk.length) }, (n) => { seen.push(n) })
    expect(verdict).toEqual({ ok: true })
    expect(written).toEqual([5, 7])
    expect(seen).toEqual([5, 12])
  })

  it('stops reading the moment the download outgrows the manifest, before the rest arrives', async () => {
    let pulled = 0
    async function * endless (): AsyncGenerator<Uint8Array> { for (;;) { pulled += 1; yield new Uint8Array(100) } }
    const verdict = await consumeDownload(endless(), { size: 250, sha256: sha(whole) }, async () => {})
    expect(verdict).toEqual({ ok: false, reason: TOO_LARGE })
    expect(pulled).toBe(3)
  })

  it('refuses a short download and a download of the right size with another hash', async () => {
    expect(await consumeDownload(pieces(whole.slice(0, 4)), { size: whole.length, sha256: sha(whole) }, async () => {})).toEqual({ ok: false, reason: WRONG_SIZE })
    expect(await consumeDownload(pieces(bytes('hello updatf')), { size: whole.length, sha256: sha(whole) }, async () => {})).toEqual({ ok: false, reason: WRONG_HASH })
  })

  it('rejects when the sink fails, so a full disk is not a success', async () => {
    await expect(consumeDownload(pieces(whole), { size: whole.length, sha256: sha(whole) }, async () => { throw new Error('disk full') })).rejects.toThrow('disk full')
  })
})
