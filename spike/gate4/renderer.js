// GATE 4 -- renderer. Downloads a torrent through the FULL shimmed stack
// (webtorrent -> shim/net.js -> contextBridge closures -> MessageChannelMain
// -> real net.Socket in main), and separately opens many concurrent TCP
// connections through the same shim to test socket-handling capacity.
//
// secure: 0, matching gate 1a's proven config -- MSE is a separate question
// (resolved by gate 1a already) and this gate isolates throughput.
import './shim/globals.js'

import WebTorrent from 'webtorrent'
import netShim from 'net'

globalThis.__gate4 = {
  netIsShimmed: () => ({ typeofConnect: typeof netShim?.connect }),

  // Downloads the whole torrent, measuring wall-clock time and (where the
  // renderer process exposes it) memory.
  downloadThroughShim: ({ magnetURI, peerAddr, timeoutMs = 120000 }) => new Promise((resolve) => {
    const started = performance.now()
    const client = new WebTorrent({
      dht: false, tracker: false, lsd: false, utp: false, secure: 0
    })
    client.on('error', (err) => finish('FAIL', { error: `client error: ${err.message}` }))

    let settled = false
    const finish = (verdict, extra = {}) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const durationSec = (performance.now() - started) / 1000
      const bytes = torrent?.length ?? 0
      resolve({
        verdict,
        bytes,
        durationSec: Number(durationSec.toFixed(3)),
        mbps: durationSec > 0 ? Number(((bytes * 8 / 1e6) / durationSec).toFixed(1)) : null,
        mbPerSec: durationSec > 0 ? Number(((bytes / 1e6) / durationSec).toFixed(1)) : null,
        memory: performance.memory
          ? { usedJSHeapMb: Number((performance.memory.usedJSHeapSize / 1e6).toFixed(1)) }
          : null,
        ...extra
      })
      try { client.destroy() } catch { /* ignore */ }
    }

    const timer = setTimeout(() => finish('TIMEOUT'), timeoutMs)

    const torrent = client.add(magnetURI, { announce: [] })
    torrent.on('infoHash', () => torrent.addPeer(peerAddr))
    torrent.on('error', (err) => finish('FAIL', { error: `torrent error: ${err.message}` }))
    torrent.on('done', () => finish('PASS'))
  }),

  // Opens `count` simultaneous TCP connections through the shim to a local
  // echo server, writes a small payload on each, and confirms every one
  // connects and echoes correctly. This is the direct, controlled test of
  // "does the shim's per-socket MessageChannelMain approach hold up at scale"
  // -- the real product-relevant question behind "concurrent sockets >= 100",
  // without needing an unrealistic 100-peer local swarm.
  concurrentSockets: ({ host, port, count, timeoutMs = 20000 }) => new Promise((resolve) => {
    const started = performance.now()
    const results = new Array(count).fill(null)
    let remaining = count

    const finish = () => {
      const ok = results.filter((r) => r?.ok).length
      resolve({
        requested: count,
        succeeded: ok,
        failed: count - ok,
        durationMs: Math.round(performance.now() - started),
        failures: results.filter((r) => r && !r.ok).slice(0, 10)
      })
    }

    const timer = setTimeout(finish, timeoutMs)

    for (let i = 0; i < count; i++) {
      const payload = new TextEncoder().encode(`ping-${i}`)
      let done = false
      const sock = netShim.connect({ host, port }, () => {
        sock.write(payload)
      })
      sock.on('data', (chunk) => {
        if (done) return
        done = true
        const text = new TextDecoder().decode(chunk)
        results[i] = { ok: text === `ping-${i}`, echoed: text }
        sock.destroy()
        if (--remaining === 0) { clearTimeout(timer); finish() }
      })
      sock.on('error', (err) => {
        if (done) return
        done = true
        results[i] = { ok: false, error: err.message }
        if (--remaining === 0) { clearTimeout(timer); finish() }
      })
    }
  })
}
