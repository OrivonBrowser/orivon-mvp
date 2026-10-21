// Bundled against the shim by ./e2e-app-network-sockets.test.ts into a fixture page's script: what a
// torrent client's DHT and tracker code does with sockets, written as ordinary Node. A `dgram` socket
// bound with no address and port 0 sends a datagram and reads the reply on the same socket, and a
// `net` server listens with no host and port 0. The test calls these functions from outside the page.

import dgram from 'dgram'
import net from 'net'

export interface UdpRoundTrip {
  readonly bound?: { readonly address: string, readonly port: number }
  readonly sendErrors?: readonly (string | null)[]
  readonly reply?: { readonly text: string, readonly address: string, readonly port: number, readonly size: number }
  readonly error?: string
}

export interface UdpRefusal {
  readonly localAddress?: string
  readonly refusal?: { readonly address: string, readonly port: number, readonly code: string }
  readonly error?: string
}

export interface TcpListen {
  readonly address?: { readonly address: string, readonly port: number }
  readonly error?: string
}

const TIMEOUT_MS = 10_000

/** Binds with no address and port 0, sends `text` to each of `targets` in order, and resolves with the first reply. */
async function roundTrip (targets: readonly number[], text: string): Promise<UdpRoundTrip> {
  const socket = dgram.createSocket('udp4')
  try {
    const reply = new Promise<NonNullable<UdpRoundTrip['reply']>>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('no reply')) }, TIMEOUT_MS)
      socket.once('error', reject)
      socket.once('message', (message: Buffer, rinfo: { address: string, port: number, size: number }) => {
        clearTimeout(timer)
        resolve({ text: message.toString(), address: rinfo.address, port: rinfo.port, size: rinfo.size })
      })
    })
    reply.catch(() => {})
    await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.bind(); socket.once('listening', () => { resolve() }) })
    const bound = socket.address()
    const sendErrors: (string | null)[] = []
    for (const port of targets) {
      sendErrors.push(await new Promise<string | null>((resolve) => {
        socket.send(text, port, '127.0.0.1', (error) => { resolve(error === null ? null : String(error)) })
      }))
    }
    return { bound: { address: bound.address, port: bound.port }, sendErrors, reply: await reply }
  } catch (error) {
    return { error: String((error as Error)?.message ?? error) }
  } finally {
    try { socket.close() } catch { /* already closed */ }
  }
}

/** The raw contract's refusal report for a send the grant does not cover, which the `dgram` shim has no event for. */
async function refusal (port: number): Promise<UdpRefusal> {
  try {
    const orivon = (globalThis as unknown as { orivon: { net: { udpBind: (o: { port: number, scope: 'local' | 'network' }) => Promise<{ localAddress: string, writable: WritableStream<unknown>, refusals: ReadableStream<{ address: string, port: number, code: string }>, close: () => Promise<void> }> } } }).orivon
    const socket = await orivon.net.udpBind({ port: 0, scope: 'local' })
    const writer = socket.writable.getWriter()
    await writer.write({ data: new TextEncoder().encode('nope'), address: '127.0.0.1', port, family: 'IPv4' })
    const first = await socket.refusals.getReader().read()
    await socket.close()
    return { localAddress: socket.localAddress, ...(first.value === undefined ? {} : { refusal: first.value }) }
  } catch (error) {
    return { error: String((error as Error)?.message ?? error) }
  }
}

let server: net.Server | undefined

/** Listens with no host and port 0, and greets each connection. */
async function listenAnywhere (): Promise<TcpListen> {
  try {
    const created = net.createServer((socket) => { socket.end('hello from the page') })
    server = created
    await new Promise<void>((resolve, reject) => { created.once('error', reject); created.listen(0, () => { resolve() }) })
    const address = created.address() as { address: string, port: number }
    return { address: { address: address.address, port: address.port } }
  } catch (error) {
    return { error: String((error as Error)?.message ?? error) }
  }
}

;(globalThis as unknown as { networkSocketsE2e: unknown }).networkSocketsE2e = {
  roundTrip,
  refusal,
  listenAnywhere,
  close: async () => { const current = server; if (current !== undefined) await new Promise<void>((resolve) => { current.close(() => { resolve() }) }) }
}
