// Bundled against the shim by ./e2e-wasi-dropped-sockets.test.ts into the fixture app's page script: the WASI 0.2
// socket host, driven the way a component's glue drives it, over the page's own orivon.net. A component that drops a
// socket must give back what it held in the broker: its slot among the origin's sockets once it connected, and its
// in-flight slot while it was still connecting. (A peer-to-peer node in WebAssembly drops most of the sockets it opens.)

import * as fs from 'fs'
import { socketInterfaces } from '../../src/shim/wasi-p2/sockets.js'
import type { IpSocketAddress, SocketNet } from '../../src/shim/wasi-p2/addresses.js'
import type { OutputStream } from '../../src/shim/wasi-p2/io.js'
import type { TcpSocket } from '../../src/shim/wasi-p2/tcp.js'

export interface DroppedSocketsResults {
  /** Rounds of sockets that connected, were written to and dropped, against a peer that never ends its side. */
  readonly rounds?: { sockets: number, connected: number, refused: string[], roomNeverReturned: number }
  /** Connects dropped before they answered, and a file call that waited behind them. */
  readonly hung?: { dials: number, probePendingBeforeDrop: boolean, probeMsAfterDrop: number, probeError: string | undefined }
  readonly error?: string
}

interface PageOrivon { net: SocketNet & { connect: (opts: { host: string, port: number }) => Promise<{ close: () => Promise<void> }> } }

// The manifest's allowance is 16: four rounds of twelve sockets are far past it unless each round gives its slots back.
const PER_ROUND = 12
const ROUNDS = 4
const DROP_GRACE_MS = 100
// 290 dials against the broker's bound of 256 in flight at once.
const FIRST_BATCH = 150
const SECOND_BATCH = 140

const wait = async (ms: number): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, ms)) }
const orivon = (): PageOrivon => (globalThis as unknown as { orivon: PageOrivon }).orivon
const address = (port: number): IpSocketAddress => ({ tag: 'ipv4', val: { port, address: [127, 0, 0, 1] } })

function createSocket (): TcpSocket {
  const interfaces = socketInterfaces(orivon().net, { dropGraceMs: DROP_GRACE_MS })
  return (interfaces['wasi:sockets/tcp-create-socket'] as { createTcpSocket: (family: string) => TcpSocket }).createTcpSocket('ipv4')
}

/** Waits until `count` sockets can be opened at once, which is room in the origin's allowance; false if it never comes. */
async function roomFor (count: number, port: number): Promise<boolean> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const probes = await Promise.allSettled(Array.from({ length: count }, async () => await orivon().net.connect({ host: '127.0.0.1', port })))
    const opened = probes.flatMap((probe) => probe.status === 'fulfilled' ? [probe.value] : [])
    await Promise.all(opened.map(async (socket) => { await socket.close() }))
    if (opened.length === count) return true
    await wait(50)
  }
  return false
}

async function roundsOfDroppedSockets (livePort: number): Promise<NonNullable<DroppedSocketsResults['rounds']>> {
  const refused: string[] = []
  let connected = 0
  let roomNeverReturned = 0
  for (let round = 0; round < ROUNDS; round++) {
    const sockets = Array.from({ length: PER_ROUND }, createSocket)
    await Promise.all(sockets.map(async (socket) => {
      try {
        socket.startConnect({}, address(livePort))
        await socket.subscribe().block()
        const [, output] = socket.finishConnect() as unknown as [unknown, OutputStream]
        await output.blockingWriteAndFlush(new TextEncoder().encode('/multistream/1.0.0\n'))
        connected += 1
      } catch (error) {
        refused.push(String(error))
      }
    }))
    for (const socket of sockets) socket[Symbol.dispose]()
    if (!await roomFor(PER_ROUND, livePort)) roomNeverReturned += 1
  }
  return { sockets: PER_ROUND * ROUNDS, connected, refused, roomNeverReturned }
}

/** Past the in-flight bound the broker makes a file call wait for a slot; dropping the sockets has to hand slots back at once. */
async function droppedDials (silentPort: number): Promise<NonNullable<DroppedSocketsResults['hung']>> {
  const sockets: TcpSocket[] = []
  const start = (count: number): void => {
    for (let i = 0; i < count; i++) {
      const socket = createSocket()
      socket.startConnect({}, address(silentPort))
      sockets.push(socket)
    }
  }
  // The control channel admits 200 calls in a burst and 100 a second after; two batches keep clear of it.
  start(FIRST_BATCH)
  await wait(1600)
  start(SECOND_BATCH)
  await wait(500)
  let probeDoneAt: number | undefined
  let probeError: string | undefined
  const probe = fs.promises.writeFile('probe.txt', 'x').then(() => { probeDoneAt = Date.now() }, (error: unknown) => { probeDoneAt = Date.now(); probeError = String(error) })
  await wait(500)
  const probePendingBeforeDrop = probeDoneAt === undefined
  const droppedAt = Date.now()
  for (const socket of sockets) socket[Symbol.dispose]()
  await probe
  return { dials: sockets.length, probePendingBeforeDrop, probeMsAfterDrop: (probeDoneAt ?? Date.now()) - droppedAt, probeError }
}

async function run (): Promise<DroppedSocketsResults> {
  const livePort = Number(document.querySelector('meta[name=live-port]')?.getAttribute('content'))
  const silentPort = Number(document.querySelector('meta[name=silent-port]')?.getAttribute('content'))
  // The dials first: hung dials only hang while the allowance has room for them, which the rounds would use up.
  const hung = await droppedDials(silentPort)
  return { rounds: await roundsOfDroppedSockets(livePort), hung }
}

;(globalThis as unknown as { droppedSocketsE2e: { run: () => Promise<DroppedSocketsResults> } }).droppedSocketsE2e = {
  run: async () => { try { return await run() } catch (error) { return { error: String((error as Error)?.stack ?? error) } } }
}
