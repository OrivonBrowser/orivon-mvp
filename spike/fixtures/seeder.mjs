// Local TCP-only seeder. Removes swarm health from every measurement.
//
// Deliberately configured with dht:false, tracker:false, lsd:false, utp:false
// so a peer can reach it ONLY by explicit TCP address. That is what makes
// gate 1a meaningful: if the renderer completes a piece from this seeder, it
// did so over an ordinary TCP connection, not over WebRTC and not by luck.
//
// Two modes, selected by whether the first argument looks like a file path:
//   Random-bytes mode (gate 4, throughput):
//     node spike/fixtures/seeder.mjs [sizeMB] [outJsonPath]
//   File mode (gate 3, video playback -- seeds a REAL file, e.g. the fixture
//   MP4, rather than incompressible random data):
//     node spike/fixtures/seeder.mjs --file /path/to/video.mp4 [outJsonPath]
import { createWriteStream, existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(join(import.meta.dirname, '../app/package.json'))
const WebTorrent = (await import(require.resolve('webtorrent'))).default

const fileMode = process.argv[2] === '--file'
const OUT = fileMode ? (process.argv[4] ?? null) : (process.argv[3] ?? null)

let file
let seedName

if (fileMode) {
  file = process.argv[3]
  if (!file || !existsSync(file)) {
    console.error(`[seeder] --file mode: path does not exist: ${file}`)
    process.exit(1)
  }
  seedName = basename(file)
  console.error(`[seeder] file mode: seeding ${file} (${statSync(file).size} bytes) as "${seedName}"`)
} else {
  const SIZE_MB = Number(process.argv[2] ?? 32)
  const dir = mkdtempSync(join(tmpdir(), 'orivon-seed-'))
  file = join(dir, 'fixture.bin')
  seedName = 'fixture.bin'

  // Deterministic-ish but incompressible content, written in 1 MB blocks.
  await new Promise((resolve, reject) => {
    const out = createWriteStream(file)
    out.on('error', reject)
    out.on('close', resolve)
    for (let i = 0; i < SIZE_MB; i++) out.write(randomBytes(1024 * 1024))
    out.end()
  })
}

// ORIVON_UPLOAD_LIMIT (bytes/sec) throttles the seeder's upload rate. Gate 3
// uses this: over an unthrottled loopback connection, even a multi-MB video
// downloads in well under a second regardless of whether seeking triggered a
// targeted piece fetch or a full sequential download -- so "resumes within 5s
// after a seek" would pass even if seeking did nothing intelligent at all.
// Throttling makes a full download take longer than the 5s pass window, so a
// fast resume after a seek is actually evidence of non-sequential fetching.
const uploadLimit = Number(process.env.ORIVON_UPLOAD_LIMIT ?? -1)

const client = new WebTorrent({
  dht: false, tracker: false, lsd: false, utp: false,
  uploadLimit
})
if (uploadLimit >= 0) {
  console.error(`[seeder] upload throttled to ${uploadLimit} B/s`)
}

client.on('error', (err) => {
  console.error('[seeder] client error:', err.message)
  process.exit(1)
})

client.seed(file, { announce: [], name: seedName }, (torrent) => {
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
  console.error(`[seeder] listening on TCP ${info.port}, infoHash ${info.infoHash}`)
})

const shutdown = () => client.destroy(() => process.exit(0))
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
