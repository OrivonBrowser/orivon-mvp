// The single table electron.vite.config.ts's renderer alias map (and
// vitest.config.ts's resolution for shim modules) is built from. Adding an
// approved dependency, or a hand-written module target, is editing one row
// here and nothing in either config. Every row matches its specifier whole,
// bare or `node:`-prefixed (aliasPattern); a subpath is a row of its own.
// 'package' rows name an npm package used as is; 'local' rows name a file
// here, which for a package-backed module wraps the package (refusing a
// missing member by name) or corrects it.
//
// Pure data plus pure transforms: no `node:*` import here, on purpose, so
// this stays testable and reviewable independent of how paths get resolved
// to absolute ones (each config's job).

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
  { specifier: 'util', status: 'ready', kind: 'local', implementation: './node-util.js', note: `The \`util\` package (approved by the owner 2026-09-10; see ${REVIEW}) for format/inspect/types/deprecate/debuglog/callbackify, plus a Node-exact promisify (registry-symbol custom form), Node's inherits, isDeepStrictEqual and TextEncoder/TextDecoder. See node-util.ts and src/shim/tests/node-util*.test.ts.` },
  { specifier: 'electron', status: 'ready', kind: 'local', implementation: '../shim-electron/index.js', note: 'Owned by a sibling stream (src/shim-electron/); this stream owns the alias map, so the entry lives here rather than there.' },
  { specifier: 'http', status: 'ready', kind: 'local', implementation: './node-http.js', note: 'request()/get(), ClientRequest (timeout, signal, auth, abort, 1xx/upgrade/connect events), IncomingMessage with backpressure, and Agent/globalAgent (options stored, never pooled), over a real net.Socket on orivon.net.connect. createServer refuses by name: there is no ServerResponse layer. See src/shim/tests/node-http-client*.test.ts.' },
  { specifier: 'https', status: 'ready', kind: 'local', implementation: './node-https.js', note: 'The http client over orivon.net.connectSecure (ADR-0017: TLS terminated in the broker) and port 443, applying tls.ts\'s option checks, an https Agent\'s options included.' },
  { specifier: 'tls', status: 'ready', kind: 'local', implementation: './node-tls.js', note: 'connect()/TLSSocket over orivon.net.connectSecure. Options that change who is trusted (ca, cert/key/pfx, secureContext, checkServerIdentity, STARTTLS over an existing socket) refuse by name; rejectUnauthorized: false is accepted with verification left on. See README.md and src/shim/tests/node-tls.test.ts.' },
  { specifier: 'net', status: 'ready', kind: 'local', implementation: './node-net.js', note: 'net.Socket (Node constructor, connect overloads, idle setTimeout, state accessors) and connect/createConnection over orivon.net.connect; net.Server/createServer over orivon.net.listen, a loopback-only listen host refused by name; isIP/isIPv4/isIPv6. See src/shim/tests/node-net-*.test.ts.' },
  { specifier: 'dgram', status: 'ready', kind: 'local', implementation: './node-dgram.js', note: 'createSocket over orivon.net.udpBind, built against k-rpc-socket\'s (bittorrent-dht\'s transport) call graph: events, address(), every send() overload validated as Node does, bind()\'s argument forms. See src/shim/tests/node-dgram-socket.test.ts.' },
  { specifier: 'dns', status: 'ready', kind: 'local', implementation: './node-dns.js', note: 'lookup/promises.lookup over orivon.net.lookup; an IP literal and localhost are answered locally. Every other dns member refuses by name. A denied resolution surfaces err.code === \'denied\'. See src/shim/tests/node-dns.test.ts.' },
  { specifier: 'fs', status: 'ready', kind: 'local', implementation: './node-fs.js', note: 'readFile/writeFile/appendFile/access/unlink/mkdir/readdir/stat/rm/rename as callback-style fs (node-fs-core.ts) and as fs.promises (node-fs-promises.ts) over the matching orivon.fs calls, sharing one core so the two surfaces cannot drift -- plus the real readFileSync (ADR-0016\'s one synchronous exception), existsSync over it, and fs.constants (node-fs-constants.ts). fs.open/fs.promises.open (node-fs-handle.ts) are real over orivon.fs.open -- a local cursor reconstructs Node\'s implicit `position: null` on top of the contract\'s deliberately explicit-position-only FileHandle. fs.createReadStream/createWriteStream (node-fs-streams.ts) are real too, over that SAME local FileHandle, not the broker\'s readable()/writable() (still stuck at A184); FileHandle\'s own instance createReadStream/createWriteStream still refuse, citing A184. First confirmed caller: @seald-io/nedb\'s Node storage layer (src/shim/tests/nedb-storage.test.ts). See src/shim/tests/node-fs*.test.ts.' },
  { specifier: 'buffer', status: 'ready', kind: 'local', implementation: './node-buffer.js', note: `The \`buffer\` package (confirmed essential: bencode/safe-buffer; approved by the owner 2026-09-10, see ${REVIEW}), plus Blob/atob/btoa from the platform. Members it lacks refuse by name.` },
  { specifier: 'events', status: 'ready', kind: 'package', implementation: 'events', note: `Confirmed essential (k-bucket, k-rpc-socket, webtorrent's own import). Approved by the owner 2026-09-10; see ${REVIEW}.` },
  { specifier: 'path', status: 'ready', kind: 'local', implementation: './node-path.js', note: `path-browserify (confirmed essential: webtorrent's own \`import path from 'path'\`; approved by the owner 2026-09-10, see ${REVIEW}), with posix pointing back at itself. Members it lacks (win32) refuse by name.` },
  { specifier: 'stream', status: 'ready', kind: 'package', implementation: 'stream-browserify', note: `Confirmed essential, transitively (crypto-browserify's Hash extends stream.Transform). Approved by the owner 2026-09-10; see ${REVIEW}.` },
  { specifier: 'crypto', status: 'ready', kind: 'local', implementation: './node-crypto.js', note: `crypto-browserify (confirmed essential: bittorrent-protocol's mse.js, DH key exchange and sha1; approved by the owner 2026-09-10, see ${REVIEW}), plus webcrypto/subtle/getRandomValues/randomUUID from the platform. Members it lacks refuse by name.` },
  { specifier: 'os', status: 'ready', kind: 'local', implementation: './node-os.js', note: `os-browserify's answers (approved by the owner 2026-09-10; see ${REVIEW}), with homedir()/tmpdir() at the virtual root (virtual-root.ts) and cpus() sized from navigator.hardwareConcurrency. Members os-browserify lacks refuse by name. See src/shim/tests/node-os.test.ts.` },
  { specifier: 'zlib', status: 'ready', kind: 'local', implementation: './node-zlib.js', note: `browserify-zlib (recon-flagged: FreeTube's main process; approved by the owner 2026-09-10, see ${REVIEW}). IMPORTANT: gzip/deflate only, via its pinned \`pako\`; browserify-zlib predates Node's brotli, so every brotli member refuses by name, and a real brotli need is a separate WASM-codec decision.` },
  { specifier: 'path/posix', status: 'ready', kind: 'local', implementation: './node-path.js', note: 'The same module as \'path\', which is POSIX already.' },
  { specifier: 'fs/promises', status: 'ready', kind: 'local', implementation: './node-fs-promises.js', note: 'The same object as fs.promises.' },
  { specifier: 'stream/promises', status: 'ready', kind: 'local', implementation: './node-stream-promises.js', note: 'The page stream\'s pipeline and finished, returning promises.' },
  { specifier: 'util/types', status: 'ready', kind: 'local', implementation: './node-util-types.js', note: 'The same object as util.types.' },
  { specifier: 'dns/promises', status: 'ready', kind: 'local', implementation: './node-dns-promises.js', note: 'The same object as dns.promises.' },
  { specifier: 'timers', status: 'ready', kind: 'local', implementation: './node-timers.js', note: 'Hand-written: the page\'s own timer functions, read at call time, and timers/promises.' },
  { specifier: 'timers/promises', status: 'ready', kind: 'local', implementation: './node-timers-promises.js', note: 'Hand-written: setTimeout and setImmediate as promises, with AbortSignal.' },
  { specifier: 'url', status: 'ready', kind: 'local', implementation: './node-url.js', note: 'Hand-written: the platform URL/URLSearchParams, fileURLToPath/pathToFileURL, and the legacy parse/format/resolve, checked against node:url.' },
  { specifier: 'querystring', status: 'ready', kind: 'local', implementation: './node-querystring.js', note: 'Hand-written, checked against node:querystring.' },
  { specifier: 'string_decoder', status: 'ready', kind: 'local', implementation: './node-string-decoder.js', note: 'Hand-written over TextDecoder\'s streaming mode, checked against node:string_decoder.' },
  { specifier: 'assert', status: 'ready', kind: 'local', implementation: './node-assert.js', note: 'Hand-written: ok/equal/strictEqual/deepEqual/deepStrictEqual/throws/rejects and their negations, AssertionError, assert.strict. Deep equality is node-deep-equal.ts, shared with util.' }
]

export interface ShimAliasEntry {
  readonly specifier: string
  readonly kind: 'local' | 'package'
  readonly implementation: string
}

/**
 * Matches `specifier` whole, bare or `node:`-prefixed. Never a string alias:
 * Vite's string form also captures every subpath, rewriting `fs/promises` to
 * `<shim>/node-fs.js/promises`, which does not exist. A subpath is its own row.
 */
export function aliasPattern (specifier: string): RegExp {
  return new RegExp(`^(?:node:)?${specifier.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`)
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
