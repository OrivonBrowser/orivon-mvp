// A standalone local DHT node, used as gate 1b's bootstrap and peer holder.
//
// The public DHT is unreachable from the spike environment (verified
// 2026-08-25: outbound UDP works -- a DNS query to 8.8.8.8 answers -- but
// router.bittorrent.com:6881 never replies). A local node keeps the gate
// measuring the SHIM rather than the network.
//
// Usage: node spike/fixtures/dht-node.mjs [outJsonPath]
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'

// Imported by absolute path, not require.resolve: bittorrent-dht declares
// `"exports": {"import": "./index.js"}` with no `require` condition, so
// createRequire().resolve() throws ERR_PACKAGE_PATH_NOT_EXPORTED.
const dhtEntry = join(import.meta.dirname, '../app/node_modules/bittorrent-dht/index.js')
const { Client: DHT } = await import(pathToFileURL(dhtEntry).href)

const OUT = process.argv[2] ?? null

// bootstrap:false -> standalone; it must not try to reach the public network.
const dht = new DHT({ bootstrap: false })

const infoHash = randomBytes(20)
const ANNOUNCED_PEER_PORT = 6881

dht.on('error', (err) => {
  console.error('[dht-node] error:', err.message)
  process.exit(1)
})

dht.listen(0, '127.0.0.1', () => {
  const address = dht.address()

  // Seed the peer store DIRECTLY.
  //
  // dht.announce() does NOT work here, and the failure is silent: announce
  // sends announce_peer to the closest nodes it knows, and a standalone node
  // with bootstrap:false knows nobody, so nothing is ever stored and a remote
  // get_peers returns empty. Verified with a plain Node DHT client -- no shim
  // involved -- which also found no peer. That control is what distinguished
  // "the fixture is wrong" from "the shim is broken".
  //
  // _addPeer writes into the same `_peers` store that the get_peers handler
  // reads (client.js:546), which is exactly what a remote lookup needs.
  dht._addPeer({ host: '127.0.0.1', port: ANNOUNCED_PEER_PORT }, infoHash)

  const info = {
    host: '127.0.0.1',
    port: address.port,
    nodeId: dht.nodeId.toString('hex'),
    infoHash: infoHash.toString('hex'),
    announcedPeerPort: ANNOUNCED_PEER_PORT
  }
  if (OUT !== null) writeFileSync(OUT, JSON.stringify(info, null, 2))
  console.log(JSON.stringify(info))
  console.error(`[dht-node] listening on 127.0.0.1:${address.port}, holding ${info.infoHash}`)
})

const shutdown = () => dht.destroy(() => process.exit(0))
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
