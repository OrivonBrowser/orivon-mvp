// A routed response body is reclaimed only when the app dropped it: a body
// being read, however slowly, survives a garbage collection.
import { describe, expect, it } from 'vitest'
import { gzipSync } from 'node:zlib'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { bytes, concat, fakeSocket, fakeTarget, installRouted } from './routed.test-helpers.js'
import type { FakeSocket } from './routed.test-helpers.js'

setFlagsFromString('--expose-gc')
const collect = runInNewContext('gc') as () => void

/** Forces collections and lets finalization callbacks run between them. */
async function collectGarbage (): Promise<void> {
  for (let i = 0; i < 4; i++) {
    collect()
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function target (): { fetch: NonNullable<ReturnType<typeof fakeTarget>['fetch']>, sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = []
  const t = fakeTarget({ connectSecure: async () => { const s = fakeSocket([], true); sockets.push(s); return s } })
  installRouted(t)
  return { fetch: t.fetch!, sockets }
}

const BODY = 'abcdefghij'.repeat(40_000)

describe('routed fetch -- a body being read survives a garbage collection', () => {
  it('delivers a Content-Length body read slowly across collections', async () => {
    const { fetch, sockets } = target()
    const pending = fetch('https://api.example/x')
    await new Promise((resolve) => setTimeout(resolve, 5))
    const wire = bytes(BODY)
    sockets[0]!.push(bytes(`HTTP/1.1 200 OK\r\nContent-Length: ${wire.byteLength}\r\n\r\n`))
    const text = (async () => await (await pending).text())()
    await collectGarbage()
    for (let at = 0; at < wire.byteLength - 20_000; at += 20_000) {
      sockets[0]!.push(wire.slice(at, at + 20_000))
      await collectGarbage()
    }
    expect(sockets[0]!.closed).toBe(false)
    sockets[0]!.push(wire.slice(wire.byteLength - 20_000))
    expect(await text).toBe(BODY)
  })

  it('delivers a chunked gzip body read slowly across collections', async () => {
    const { fetch, sockets } = target()
    const pending = fetch('https://api.example/x', { headers: { 'Accept-Encoding': 'gzip' } })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const zipped = new Uint8Array(gzipSync(Buffer.from(BODY)))
    sockets[0]!.push(bytes('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Encoding: gzip\r\n\r\n'))
    const text = (async () => await (await pending).text())()
    await collectGarbage()
    const piece = Math.max(1, Math.ceil(zipped.byteLength / 8))
    for (let at = 0; at < zipped.byteLength; at += piece) {
      const part = zipped.slice(at, at + piece)
      sockets[0]!.push(concat(bytes(`${part.byteLength.toString(16)}\r\n`), part, bytes('\r\n')))
      await collectGarbage()
    }
    expect(sockets[0]!.closed).toBe(false)
    sockets[0]!.push(bytes('0\r\n\r\n'))
    expect(await text).toBe(BODY)
  })

  it('still releases the socket of a response the app dropped unread', async () => {
    const { fetch, sockets } = target()
    const dropped = async (): Promise<void> => { await fetch('https://api.example/x') }
    const pending = dropped()
    await new Promise((resolve) => setTimeout(resolve, 5))
    sockets[0]!.push(concat(bytes('HTTP/1.1 200 OK\r\nContent-Length: 2000000\r\n\r\n'), new Uint8Array(1_000_000)))
    await pending
    await collectGarbage()
    await collectGarbage()
    expect(sockets[0]!.closed).toBe(true)
  })
})
