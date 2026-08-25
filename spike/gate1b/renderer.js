// GATE 1b -- renderer. Runs a real DHT node inside the sandboxed page,
// speaking the BitTorrent DHT protocol over the shimmed dgram.
//
// bittorrent-dht is pure JavaScript (verified: no native dependencies), so the
// only thing standing between it and the renderer is `dgram`. This gate proves
// the shim carries genuine message-oriented protocol traffic -- KRPC over UDP
// with real bencoded queries and responses -- not just bytes on a pipe.
import './shim/globals.js'

import DHTModule from 'bittorrent-dht'
import dgramShim from 'dgram'

const DHT = DHTModule.Client ?? DHTModule

globalThis.__gate1b = {
  dgramIsShimmed: () => ({
    typeofCreateSocket: typeof dgramShim?.createSocket,
    isFalse: dgramShim === false,
    hasSocket: typeof dgramShim?.Socket === 'function'
  }),

  // Reports the DHT's internal wiring after construction.
  inspect: async ({ bootstrap }) => {
    const out = {}
    const dht = new DHT({ bootstrap })
    out.hasRpc = !!dht._rpc
    out.bootstrapParsed = JSON.stringify(dht._rpc?.bootstrap ?? null)
    out.krpcSocketPresent = !!dht._rpc?.socket
    out.udpSocketCtor = dht._rpc?.socket?.socket?.constructor?.name ?? null
    out.warnings = []
    dht.on('warning', (e) => out.warnings.push(String(e?.message ?? e)))
    dht.on('error', (e) => out.warnings.push(`error: ${String(e?.message ?? e)}`))
    dht.listen(0, () => {})
    await new Promise((r) => setTimeout(r, 5000))
    out.ready = dht.ready
    try { dht.destroy() } catch { /* ignore */ }
    return out
  },

  // Isolates the shim's send path from anything the DHT does.
  probeSend: ({ host, port }) => new Promise((resolve) => {
    const s = dgramShim.createSocket('udp4')
    const out = { bound: false, sent: false, error: null, replyBytes: null }
    s.on('error', (e) => { out.error = String(e) })
    s.on('message', (msg) => { out.replyBytes = msg.length })
    s.on('listening', () => {
      out.bound = true
      try {
        s.send(new Uint8Array([1, 2, 3, 4]), 0, 4, port, host, () => { out.sent = true })
      } catch (err) {
        out.error = `send threw: ${String(err)}`
      }
    })
    s.bind(0)
    setTimeout(() => { try { s.close() } catch { /* ignore */ } resolve(out) }, 3000)
  }),

  run: ({ bootstrap, infoHashHex, timeoutMs = 60000 }) => new Promise((resolve) => {
    const started = performance.now()
    const events = []
    const log = (m) => events.push(`${Math.round(performance.now() - started)}ms ${m}`)

    const peers = []
    let dht
    let settled = false

    const finish = (verdict, extra = {}) => {
      if (settled) return
      settled = true
      const result = {
        verdict,
        events,
        peers,
        elapsedMs: Math.round(performance.now() - started),
        ...extra
      }
      try { dht?.destroy() } catch { /* ignore */ }
      resolve(result)
    }

    const timer = setTimeout(() => finish('TIMEOUT'), timeoutMs)

    try {
      dht = new DHT({ bootstrap })
    } catch (err) {
      clearTimeout(timer)
      finish('FAIL', { error: `constructing DHT: ${String(err)}`, stack: String(err&&err.stack).split('\n').slice(0,8) })
      return
    }

    dht.on('error', (err) => log(`dht error: ${err.message}`))

    dht.on('ready', () => {
      log('dht ready (bootstrap answered over the shimmed dgram)')
      dht.lookup(infoHashHex, (err) => {
        if (err) log(`lookup error: ${err.message}`)
      })
    })

    dht.on('node', (node) => {
      if (events.filter((e) => e.includes('node seen')).length < 3) {
        log(`node seen ${node.host}:${node.port}`)
      }
    })

    dht.on('peer', (peer, hash) => {
      log(`PEER ${peer.host}:${peer.port} for ${hash.toString('hex').slice(0, 12)}`)
      peers.push({ host: peer.host, port: peer.port })
      clearTimeout(timer)
      finish('PASS')
    })

    dht.listen(0, () => {
      let addr = null
      try { addr = dht.address() } catch (err) { log(`address() threw: ${String(err)}`) }
      log(`listening, local address ${addr ? `${addr.address}:${addr.port}` : 'unknown'}`)
    })
  })
}
