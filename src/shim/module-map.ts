// The single table electron.vite.config.ts's renderer.resolve.alias map is
// built from. Adding an approved dependency, or a hand-written polyfill,
// becomes editing one row here and nothing in the build config -- the point
// of this file, not a nicety: this repo has zero runtime dependencies today,
// and every "ready, package" row below is currently hypothetical, waiting
// on an owner decision (docs/planning/shim-dependency-review.md).
//
// Pure data plus a pure transform: no `node:*` import here, on purpose, so
// this stays testable and reviewable independent of how paths eventually
// get resolved to absolute ones (electron.vite.config.ts's job, since it
// already has `root`).

export type ShimModuleStatus = 'ready' | 'pending-dependency'

export interface ShimModuleEntry {
  readonly specifier: string
  readonly status: ShimModuleStatus
  /** Only meaningful when `status` is 'ready'. 'local': implementation is a path relative to src/shim/. 'package': implementation is an npm package name. */
  readonly kind?: 'local' | 'package'
  readonly implementation?: string
  readonly note: string
}

const REVIEW = 'docs/planning/shim-dependency-review.md'

export const SHIM_MODULE_MAP: readonly ShimModuleEntry[] = [
  { specifier: 'util', status: 'ready', kind: 'local', implementation: './node-util.js', note: `Hand-written, inherits-only -- the only confirmed live caller in the Phase 5 dependency trees. The npm \`util\` package was approved alongside the other seven (owner decision, 2026-09-10) but deliberately left unused: it would pull four more packages to reach a function this file already implements in ten lines against a frozen API. Extend this file, not the package, if a real caller needs more of \`util\`. See node-util.ts and ${REVIEW}.` },
  { specifier: 'electron', status: 'ready', kind: 'local', implementation: '../shim-electron/index.js', note: 'Owned by a sibling stream (src/shim-electron/); this stream owns the alias map, so the entry lives here rather than there.' },
  { specifier: 'http', status: 'ready', kind: 'local', implementation: './node-http.js', note: 'Queue item 3.3: request()/get(), ClientRequest, IncomingMessage over orivon.net.connect. No confirmed caller in the current webtorrent/bittorrent-tracker dependency trees -- both moved to fetch (queue item 3.4) since the training-data-era assumption that motivated this item; server-side createServer() throws a named error (A114). Built to Node\'s documented client behaviour and verified against a real node:http server, not against a caller\'s shipped code. See src/shim/tests/node-http-client.test.ts.' },
  { specifier: 'https', status: 'ready', kind: 'local', implementation: './node-https.js', note: 'Same client as \'http\', over orivon.net.connectSecure (ADR-0017: TLS terminated in the broker, plaintext handed to this shim) and port 443. Same caller caveat as \'http\' above.' },
  { specifier: 'net', status: 'ready', kind: 'local', implementation: './node-net.js', note: 'Queue item 3.2: net.connect/createConnection as a real stream.Duplex over orivon.net.connect, plus net.isIP (a confirmed k-rpc-socket caller, not a socket method -- see README.md requirement 1). net.createServer throws a named error citing A114 (node-net-unsupported.ts): TcpServer.connections cannot reach a page yet. See src/shim/tests/node-net-socket.test.ts.' },
  { specifier: 'dgram', status: 'ready', kind: 'local', implementation: './node-dgram.js', note: 'Queue item 3.2: dgram.createSocket over orivon.net.udpBind, built against k-rpc-socket\'s (bittorrent-dht\'s transport) real call graph -- message/error/listening/close events, address(), the 6-argument send() form, and bind()\'s flexible argument forwarding. See src/shim/tests/node-dgram-socket.test.ts and the real-bittorrent-dht integration test.' },
  { specifier: 'dns', status: 'ready', kind: 'local', implementation: './node-dns.js', note: 'dns.lookup throws a named, closed error (node-dns.ts) rather than resolving anything -- DNS needs its own broker network-permission capability that does not exist yet (owner decision, out of scope for queue item 3.2). The one confirmed caller, k-rpc-socket\'s `_resolveAndQuery`, only reaches this for a hostname bootstrap peer; every literal-IP peer never calls it (net.isIP routes around it).' },
  { specifier: 'fs', status: 'ready', kind: 'local', implementation: './node-fs.js', note: 'Queue item 3.2: readFile/writeFile/mkdir/readdir/stat/rm/rename as callback-style fs over the matching orivon.fs promises, plus the real readFileSync (ADR-0016\'s one synchronous exception). Every OTHER synchronous export (statSync included -- a real, unguessed caller: fs-chunk-store and webtorrent\'s own torrent.js both call it at module load) and fs.open/FileHandle throw named errors (node-fs-unsupported.ts) rather than faking a capability the broker does not have.' },
  { specifier: 'buffer', status: 'ready', kind: 'package', implementation: 'buffer', note: `Confirmed essential (bencode/safe-buffer). Approved by the owner 2026-09-10; see ${REVIEW}.` },
  { specifier: 'events', status: 'ready', kind: 'package', implementation: 'events', note: `Confirmed essential (k-bucket, k-rpc-socket, webtorrent's own import). Approved by the owner 2026-09-10; see ${REVIEW}.` },
  { specifier: 'path', status: 'ready', kind: 'package', implementation: 'path-browserify', note: `Confirmed essential (webtorrent's own \`import path from 'path'\`). Approved by the owner 2026-09-10; see ${REVIEW}.` },
  { specifier: 'stream', status: 'ready', kind: 'package', implementation: 'stream-browserify', note: `Confirmed essential, transitively (crypto-browserify's Hash extends stream.Transform). Approved by the owner 2026-09-10; see ${REVIEW}.` },
  { specifier: 'crypto', status: 'ready', kind: 'package', implementation: 'crypto-browserify', note: `Confirmed essential (bittorrent-protocol's mse.js: DH key exchange, sha1). Approved by the owner 2026-09-10; see ${REVIEW}.` },
  { specifier: 'os', status: 'ready', kind: 'package', implementation: 'os-browserify', note: `On the compatibility-matrix.md floor; no live caller confirmed in the review's pass, but approved anyway (owner decision, 2026-09-10) to avoid an unattended run stalling on a 3am gap. See ${REVIEW}.` },
  { specifier: 'zlib', status: 'ready', kind: 'package', implementation: 'browserify-zlib', note: `Recon-flagged (FreeTube's main process, brotli); no live caller confirmed in the Node lane. Approved anyway (owner decision, 2026-09-10), same reasoning as 'os'. IMPORTANT: this does NOT close the brotli gap -- browserify-zlib predates Node's own brotli support and supplies gzip/deflate only (via its pinned \`pako\` dependency); a real brotli need is a separate WASM-codec decision, not a consequence of this row. See ${REVIEW}.` }
]

export interface ShimAliasEntry {
  readonly specifier: string
  readonly kind: 'local' | 'package'
  readonly implementation: string
}

/** Every 'ready' row, in the shape electron.vite.config.ts resolves into its alias map. Silently drops every 'pending-dependency' row -- there is nothing yet to point an alias at. */
export function buildAliasEntries (): readonly ShimAliasEntry[] {
  const entries: ShimAliasEntry[] = []
  for (const entry of SHIM_MODULE_MAP) {
    if (entry.status !== 'ready' || entry.kind === undefined || entry.implementation === undefined) continue
    entries.push({ specifier: entry.specifier, kind: entry.kind, implementation: entry.implementation })
  }
  return entries
}
