// GATE 1a -- renderer. Runs webtorrent inside the sandboxed page.
//
// The client is created with dht:false, tracker:false, lsd:false, utp:false and
// the peer is added by explicit address. There is therefore NO signalling
// channel of any kind, so a WebRTC peer cannot exist. If a piece verifies, it
// came over TCP through the shim -- which is the whole question of this gate.
// MUST be first: installs process/global/Buffer before any dependency reads
// them at module-evaluation time. See shim/globals.js.
import './shim/globals.js'

import WebTorrent from 'webtorrent'
import netShim from 'net'

globalThis.__gate1a = {
  // Proves the alias beat webtorrent's `browser` field, which maps net -> false.
  // torrent.js:2104 bails out unless typeof net.connect === 'function', so this
  // is the exact condition that decides WebRTC-only vs real BitTorrent.
  netIsShimmed: () => ({
    typeofConnect: typeof netShim?.connect,
    isFalse: netShim === false,
    hasSocket: typeof netShim?.Socket === 'function'
  }),

  run: ({ magnetURI, peerAddr, timeoutMs = 60000, secure = 0 }) => new Promise((resolve) => {
    const started = performance.now()
    const events = []
    const log = (m) => events.push(`${Math.round(performance.now() - started)}ms ${m}`)

    // secure: 0 disables BitTorrent protocol encryption (MSE).
    //
    // NOT a convenience. webtorrent defaults to secure: 1 (index.js:99), but
    // bittorrent-protocol browser-excludes mse.js, and making MSE work in a
    // renderer needs Diffie-Hellman, a synchronous SHA-1 and RC4 -- none of
    // which WebCrypto offers in a usable form. This is a real v0 limitation,
    // recorded in the gate 1a findings, not a spike shortcut.
    const client = new WebTorrent({
      dht: false, tracker: false, lsd: false, utp: false, secure: 0
    })

    const finish = (verdict, extra = {}) => {
      let wires = []
      try {
        wires = (torrent?.wires ?? []).map((w) => ({
          remoteAddress: w.remoteAddress ?? null,
          type: w.type ?? null,
          peerId: typeof w.peerId === 'string' ? w.peerId.slice(0, 12) : null
        }))
      } catch { /* torrent may be gone */ }

      const result = {
        verdict,
        events,
        wires,
        downloaded: torrent?.downloaded ?? 0,
        numPeers: torrent?.numPeers ?? 0,
        progress: torrent?.progress ?? 0,
        elapsedMs: Math.round(performance.now() - started),
        ...extra
      }
      try { client.destroy() } catch { /* ignore */ }
      resolve(result)
    }

    client.on('error', (err) => log(`client error: ${err.message}`))

    const timer = setTimeout(() => finish('TIMEOUT'), timeoutMs)

    const torrent = client.add(magnetURI, { announce: [], store: undefined }, () => {
      log('metadata ready')
    })

    torrent.on('infoHash', () => {
      log(`infoHash, adding peer ${peerAddr}`)
      torrent.addPeer(peerAddr)
    })

    torrent.on('wire', (wire, addr) => {
      log(`WIRE connected: ${addr} type=${wire.type ?? 'unknown'}`)
    })

    torrent.on('metadata', () => log('metadata'))

    torrent.on('verified', (index) => {
      log(`piece ${index} VERIFIED`)
      clearTimeout(timer)
      // One verified piece from a TCP peer is the gate. Do not wait for the
      // whole file -- that is gate 4's job.
      finish('PASS')
    })

    torrent.on('error', (err) => {
      log(`torrent error: ${err.message}`)
      clearTimeout(timer)
      finish('FAIL', { error: err.message })
    })
  })
}
