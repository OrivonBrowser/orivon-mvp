// GATE 4 control. Downloads a torrent NATIVELY in Node -- no Electron, no
// shim, no IPC boundary at all -- so gate 4 has a real baseline to compare
// the shimmed path against. Without this number, any throughput figure from
// the shimmed path measures the disk and the machine, not the shim.
//
// Usage: node spike/fixtures/control.mjs <seedInfoJsonPath>
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(join(import.meta.dirname, '../app/package.json'))
const WebTorrent = (await import(require.resolve('webtorrent'))).default

const seedInfoPath = process.argv[2]
if (!seedInfoPath) {
  console.error('usage: node control.mjs <seedInfoJsonPath>')
  process.exit(1)
}
const info = JSON.parse(readFileSync(seedInfoPath, 'utf8'))

const client = new WebTorrent({ dht: false, tracker: false, lsd: false, utp: false })
client.on('error', (err) => { console.error('[control] client error:', err.message); process.exit(1) })

const started = performance.now()
let peakRss = process.memoryUsage().rss

const rssTimer = setInterval(() => {
  const rss = process.memoryUsage().rss
  if (rss > peakRss) peakRss = rss
}, 200)

const torrent = client.add(info.magnetURI, { announce: [] })
torrent.on('infoHash', () => torrent.addPeer(`127.0.0.1:${info.port}`))
torrent.on('error', (err) => { console.error('[control] torrent error:', err.message); process.exit(1) })

torrent.on('done', () => {
  clearInterval(rssTimer)
  const durationSec = (performance.now() - started) / 1000
  const mbps = (torrent.length * 8 / 1e6) / durationSec // megabits/sec, matching the 25 Mbps criterion's units
  const mbPerSec = (torrent.length / 1e6) / durationSec
  const result = {
    bytes: torrent.length,
    durationSec: Number(durationSec.toFixed(3)),
    mbps: Number(mbps.toFixed(1)),
    mbPerSec: Number(mbPerSec.toFixed(1)),
    peakRssMb: Number((peakRss / 1e6).toFixed(1))
  }
  console.log(JSON.stringify(result))
  client.destroy(() => process.exit(0))
})

setTimeout(() => {
  console.error(`[control] TIMEOUT, downloaded ${torrent.downloaded}/${torrent.length}`)
  process.exit(1)
}, 120000)
