// The stand-in for the Nym module that the end-to-end specs of the tunnel run in place of the real one (the
// ORIVON_TEST_NYM_MODULE seam). It has the module's exports, connects to local servers named by a file the spec
// writes, and logs what it is asked, so the log says what went where. It answers the host's own name lookups (port 53
// datagrams) with an address per name, as a resolver reached through the mixnet would.
//
// What a spec writes into the file `ORIVON_TEST_NYM_FAKE` names: `log` (the file to append to), `targets` (name:port to
// a local address), `failStart`, `failFirstSetups` (how many tunnels fail to come up before one does), `startDelayMs`
// (how long a tunnel takes to come up), `silentDnsTunnels` (how many tunnels that do come up never answer a name
// lookup) and `hangConnect` (a stream that never opens).

export const EMPTY_WASM = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])

export const FAKE_NYM_MODULE = `
import net from 'node:net'
import dgram from 'node:dgram'
import fs from 'node:fs'
const config = () => JSON.parse(fs.readFileSync(process.env.ORIVON_TEST_NYM_FAKE, 'utf8'))
const log = (line) => fs.appendFileSync(config().log, line + '\\n')
let client = ''
/** Names the stand-in's resolver has answered for, by the address it gave: the host looks a name up before it asks the module for a stream, as it does with the real module. */
const names = globalThis.__orivonStandInNames ??= { byAddress: new Map(), next: 1, setups: 0 }
let tunnelNumber = 0
export function initSync () {}
export function main () {}
export async function setupMixTunnel (options) {
  if (config().failStart) throw new Error('the stand-in gateway is unreachable')
  tunnelNumber = ++names.setups
  if (tunnelNumber <= (config().failFirstSetups ?? 0)) throw new Error('the stand-in gateway closed the connection')
  if (config().startDelayMs) await new Promise((resolve) => setTimeout(resolve, config().startDelayMs))
  client = options.clientId.replace(/-[0-9a-f]{12}$/, '')
  log('options ' + client + ' ' + JSON.stringify({ disablePoissonTraffic: options.disablePoissonTraffic, disableCoverTraffic: options.disableCoverTraffic }))
  log('up ' + client)
}
export async function disconnectMixTunnel () { log('down ' + client) }
export async function connectTcp (address, port) {
  if (config().hangConnect) await new Promise(() => {})
  // A name handed to the module (rather than an address its own resolver gave) is a lookup this tunnel does not answer.
  if (names.byAddress.get(address) === undefined && tunnelNumber <= (config().silentDnsTunnels ?? 0) + (config().failFirstSetups ?? 0)) await new Promise(() => {})
  const host = names.byAddress.get(address) ?? address
  const target = config().targets[host + ':' + port]
  if (target === undefined) throw new Error('no such name')
  log('tcp ' + client + ' ' + host + ':' + port)
  const socket = net.connect(target.port, target.host)
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
  const chunks = []
  let wake
  socket.on('data', (data) => { chunks.push(new Uint8Array(data)); wake?.() })
  socket.on('close', () => { chunks.push(null); wake?.() })
  socket.on('error', () => {})
  return {
    read: async () => { while (chunks.length === 0) await new Promise((resolve) => { wake = resolve }); return chunks.shift() },
    write: async (bytes) => { socket.write(bytes) },
    close: async () => { socket.end() }
  }
}
export async function bindUdp () {
  const queue = []
  let wake
  let closed = false
  const socket = dgram.createSocket('udp4')
  return {
    sendTo: async (host, port, bytes) => {
      if (port === 53 && config().targets[host + ':' + port] === undefined) {
        if (tunnelNumber <= (config().silentDnsTunnels ?? 0) + (config().failFirstSetups ?? 0)) return
        const query = Buffer.from(bytes)
        const labels = []
        let end = 12
        while (query[end] !== 0) { labels.push(query.subarray(end + 1, end + 1 + query[end]).toString()); end += query[end] + 1 }
        const address = '203.0.113.' + String(names.next++)
        names.byAddress.set(address, labels.join('.'))
        const record = Buffer.concat([Buffer.from([0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4]), Buffer.from(address.split('.').map(Number))])
        const header = Buffer.from([query[0], query[1], 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0])
        queue.push({ data: new Uint8Array(Buffer.concat([header, query.subarray(12, end + 5), record])), host, port })
        wake?.()
        return
      }
      const target = config().targets[host + ':' + port]
      if (target === undefined) throw new Error('no such name')
      log('udp ' + client + ' ' + host + ':' + port)
      socket.once('message', (data) => { queue.push({ data: new Uint8Array(data), host: '203.0.113.9', port }); wake?.() })
      socket.send(bytes, target.port, target.host)
    },
    recv: async (timeoutMs) => {
      const deadline = Date.now() + (timeoutMs ?? 60000)
      while (queue.length === 0) {
        if (closed) throw new Error('UDP socket closed')
        if (Date.now() > deadline) throw new Error('UDP receive timed out')
        await new Promise((resolve) => { wake = resolve; setTimeout(resolve, 50) })
      }
      return queue.shift()
    },
    close: () => { closed = true; try { socket.close() } catch {} }
  }
}
`
