// bittorrent-dht, disabled — GATE 1a ONLY.
//
// webtorrent's `browser` field maps bittorrent-dht to false, and
// torrent-discovery statically imports `{ Client as DHT }` from it. Under
// browserify that yields undefined; under Rollup it is a build error.
//
// torrent-discovery/index.js:75 reads:
//     if (opts.dht === false || typeof DHT !== 'function') { this.dht = null }
//
// so exporting a NON-FUNCTION reproduces the browser build's behaviour exactly:
// DHT disables itself gracefully rather than throwing.
//
// Gate 1a is about reaching an ordinary TCP peer by explicit address, so DHT
// is deliberately out of the picture. GATE 1b replaces this alias with the
// REAL bittorrent-dht (which is pure JS) over a shimmed `dgram`.
export const Client = undefined
export default {}
