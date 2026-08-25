// Local TCP-only seeder. Removes swarm health from every measurement.
//
// Deliberately configured with dht:false, tracker:false, lsd:false, utp:false
// so a peer can reach it ONLY by explicit TCP address. That is what makes
// gate 1a meaningful: if the renderer completes a piece from this seeder, it
// did so over an ordinary TCP connection, not over WebRTC and not by luck.
//
// Usage: node spike/fixtures/seeder.mjs [sizeMB] [outJsonPath]
import { createWriteStream, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(join(import.meta.dirname, '../app/package.json'))
const WebTorrent = (await import(require.resolve('webtorrent'))).default

const SIZE_MB = Number(process.argv[2] ?? 32)
const OUT = process.argv[3] ?? null

const dir = mkdtempSync(join(tmpdir(), 'orivon-seed-'))
const file = join(dir, 'fixture.bin')

// Deterministic-ish but incompressible content, written in 1 MB blocks.
await new Promise((resolve, reject) => {
  const out = createWriteStream(file)
  out.on('error', reject)
  out.on('close', resolve)
  for (let i = 0; i < SIZE_MB; i++) out.write(randomBytes(1024 * 1024))
  out.end()
})

const client = new WebTorrent({ dht: false, tracker: false, lsd: false, utp: false })

client.on('error', (err) => {
  console.error('[seeder] client error:', err.message)
  process.exit(1)
})

client.seed(file, { announce: [], name: 'fixture.bin' }, (torrent) => {
  const info = {
    infoHash: torrent.infoHash,
    magnetURI: torrent.magnetURI,
    port: client.torrentPort,
    sizeBytes: torrent.length,
    pieceLength: torrent.pieceLength,
    files: torrent.files.map((f) => ({ name: f.name, length: f.length }))
  }
  if (OUT !== null) writeFileSync(OUT, JSON.stringify(info, null, 2))
  console.log(JSON.stringify(info))
  console.error(`[seeder] listening on TCP ${info.port}, ${SIZE_MB} MB, infoHash ${info.infoHash}`)
})

const shutdown = () => client.destroy(() => process.exit(0))
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
