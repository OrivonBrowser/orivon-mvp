// THE EXIT-CRITERION TEST: a real, unmodified k-rpc-socket instance --
// bittorrent-dht's actual UDP transport, not a stand-in -- driven entirely
// through this shim's dgram.Socket, over two real loopback UDP ports
// (real-udp-bridge.ts). Two independent "nodes" perform a real bencode
// ping/pong round trip: real transaction-ID tracking, real timeout timers,
// real net.isIP()-based routing, real send/receive.
//
// SKIPPED, NOT FAILED, WHEN THE VENDORED PACKAGE ISN'T PRESENT. k-rpc-socket
// lives in spike/app/node_modules/, which is .gitignore'd (a local install
// artifact, never committed) -- so a clean checkout or CI runner will not
// have it. This file proves the shim's completeness in an environment that
// does, without making the gate depend on an uncommitted directory existing.
// See this lane's PR body for what was actually run and where.

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Socket as ShimDgramSocket } from '../node-dgram-socket.js'
import { isIP as shimIsIP } from '../node-net-isip.js'
import { bindViaRealUdp } from './support/real-udp-bridge.js'

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..')
const kRpcSocketPath = resolve(repoRoot, 'spike/app/node_modules/k-rpc-socket/index.js')
const vendored = existsSync(kRpcSocketPath)

interface KRpcSocketPeer { host: string, port: number, id?: Buffer }
interface KRpcSocketMessage { t: Buffer, y: string, q?: string, a?: object, r?: object }
type KRpcSocketQueryCallback = (error: Error | null, message?: KRpcSocketMessage, peer?: KRpcSocketPeer) => void

interface KRpcSocket {
  bind: (port: number, cb: () => void) => void
  query: (peer: KRpcSocketPeer, message: { q: string, a: object }, cb: KRpcSocketQueryCallback) => void
  response: (peer: KRpcSocketPeer, req: { t: Buffer }, res: object) => void
  on: (event: string, listener: (...args: unknown[]) => void) => void
  destroy: () => void
}

/** A fresh "node": a real loopback UDP port, this shim's dgram.Socket on top, k-rpc-socket's real RPC on top of that. */
async function createNode (RPC: new (opts: object) => KRpcSocket): Promise<{ rpc: KRpcSocket, port: number }> {
  const socket = new ShimDgramSocket(bindViaRealUdp())
  const rpc = new RPC({ socket, isIP: shimIsIP })
  const port = await new Promise<number>((resolvePort) => {
    rpc.bind(0, () => {
      const address = (socket as unknown as { address: () => { port: number } }).address()
      resolvePort(address.port)
    })
  })
  return { rpc, port }
}

describe.skipIf(!vendored)('a real k-rpc-socket instance against this shim\'s dgram.Socket', () => {
  it('completes a real ping/pong: bencode wire bytes, transaction IDs and net.isIP-based routing all real', async () => {
    const { default: RPC } = await import(pathToFileURL(kRpcSocketPath).href) as { default: new (opts: object) => KRpcSocket }

    const a = await createNode(RPC)
    const b = await createNode(RPC)

    const pong = await new Promise<KRpcSocketMessage>((resolvePong, reject) => {
      b.rpc.on('query', (query: unknown, peer: unknown) => {
        const q = query as KRpcSocketMessage
        // bencode.decode returns every string-typed field as a Buffer, `q`
        // included -- a real, easy-to-miss trap this test's own first draft
        // hit (`q.q === 'ping'` compared a Buffer to a string and silently
        // never matched, timing out for a reason that looked like a shim bug).
        if (q.q?.toString() === 'ping') b.rpc.response(peer as KRpcSocketPeer, { t: q.t }, { id: Buffer.from('node-b-id-000000000') })
      })
      // A literal IP address on both sides: net.isIP() must return non-zero
      // here, or k-rpc-socket routes this through dns.lookup instead (this
      // shim's node-dns.ts refuses that on purpose -- see its own header).
      a.rpc.query({ host: '127.0.0.1', port: b.port }, { q: 'ping', a: { id: Buffer.from('node-a-id-000000000') } }, (error, message) => {
        if (error !== null) { reject(error); return }
        resolvePong(message as KRpcSocketMessage)
      })
    })

    expect(pong.y.toString()).toBe('r')
    expect((pong.r as { id: Buffer }).id.toString()).toBe('node-b-id-000000000')

    a.rpc.destroy()
    b.rpc.destroy()
  })

  it('a query to a real closed port times out through k-rpc-socket\'s own real timer, not a shim shortcut', async () => {
    const { default: RPC } = await import(pathToFileURL(kRpcSocketPath).href) as { default: new (opts: object) => KRpcSocket }
    const a = await createNode(RPC)

    const error = await new Promise<Error>((resolvePong) => {
      a.rpc.query({ host: '127.0.0.1', port: 1 }, { q: 'ping', a: { id: Buffer.from('node-a-id-000000000') } }, (err) => {
        resolvePong(err as Error)
      })
    })
    expect((error as Error & { code?: string }).code).toBe('ETIMEDOUT')
    a.rpc.destroy()
  }, 10_000)
})

const bittorrentDhtPath = resolve(repoRoot, 'spike/app/node_modules/bittorrent-dht/index.js')
const dhtVendored = existsSync(bittorrentDhtPath) && vendored

interface DhtNode { id?: Buffer, host: string, port: number }
interface DhtClient {
  listen: (port: number, cb: () => void) => void
  address: () => { port: number }
  destroy: (cb: () => void) => void
  _sendPing: (node: DhtNode, cb: (error: Error | null, pong?: { id: Buffer }) => void) => void
}

describe.skipIf(!dhtVendored)('a real, unmodified bittorrent-dht Client against this shim', () => {
  it('pings a second real DHT node and gets back its real node ID -- no source in bittorrent-dht itself was touched', async () => {
    const { default: RPC } = await import(pathToFileURL(kRpcSocketPath).href) as { default: new (opts: object) => KRpcSocket }
    const { default: DHT } = await import(pathToFileURL(bittorrentDhtPath).href) as { default: new (opts: object) => DhtClient }

    function krpcSocket (): KRpcSocket {
      return new RPC({ socket: new ShimDgramSocket(bindViaRealUdp()), isIP: shimIsIP })
    }

    const dhtA = new DHT({ krpcSocket: krpcSocket(), bootstrap: false })
    const dhtB = new DHT({ krpcSocket: krpcSocket(), bootstrap: false })

    await new Promise<void>((r) => dhtA.listen(0, r))
    await new Promise<void>((r) => dhtB.listen(0, r))

    const pong = await new Promise<{ id: Buffer }>((resolvePong, reject) => {
      dhtA._sendPing({ host: '127.0.0.1', port: dhtB.address().port }, (error, result) => {
        if (error !== null) { reject(error); return }
        resolvePong(result as { id: Buffer })
      })
    })

    expect(Buffer.isBuffer(pong.id)).toBe(true)
    expect(pong.id).toHaveLength(20)

    await Promise.all([
      new Promise<void>((r) => dhtA.destroy(r)),
      new Promise<void>((r) => dhtB.destroy(r))
    ])
  })
})

describe.skipIf(vendored)('real-bittorrent-dht.test.ts', () => {
  it('is skipped: spike/app/node_modules/k-rpc-socket is not present in this checkout', () => {
    expect(vendored).toBe(false)
  })
})
