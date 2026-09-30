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
  /** True for a module Node exposes only as `node:<specifier>`: the bare name is a different npm package, so an alias must not capture it. */
  readonly prefixOnly?: boolean
}

const REVIEW = 'docs/planning/shim-dependency-review.md'

export const SHIM_MODULE_MAP: readonly ShimModuleEntry[] = [
  { specifier: 'util', status: 'ready', kind: 'local', implementation: './polyfills/util.js', note: `The \`util\` package (approved by the owner 2026-09-10; see ${REVIEW}) for format/inspect/types/deprecate/debuglog/callbackify, plus a Node-exact promisify (registry-symbol custom form), Node's inherits, isDeepStrictEqual and TextEncoder/TextDecoder. See polyfills/util.ts and src/shim/polyfills/tests/util*.test.ts.` },
  { specifier: 'electron', status: 'ready', kind: 'local', implementation: '../shim-electron/index.js', note: 'Owned by a sibling stream (src/shim-electron/); this stream owns the alias map, so the entry lives here rather than there.' },
  { specifier: 'http', status: 'ready', kind: 'local', implementation: './http/http.js', note: 'request()/get(), ClientRequest (timeout, signal, auth, abort, 1xx/upgrade/connect events), IncomingMessage with backpressure, and Agent/globalAgent (options stored, never pooled), over a real net.Socket on orivon.net.connect; createServer/Server/ServerResponse/OutgoingMessage over net.Server on orivon.net.listen (keep-alive, chunked bodies both ways, pipelined requests answered in order, Expect: 100-continue, upgrade/connect, keepAliveTimeout/headersTimeout/requestTimeout, close() waiting for requests in flight; listen hosts as net.Server takes them). See src/shim/http/README.md and src/shim/http/tests/.' },
  { specifier: 'https', status: 'ready', kind: 'local', implementation: './http/https.js', note: 'The http client over orivon.net.connectSecure (ADR-0017: TLS terminated in the broker) and port 443, applying tls.ts\'s option checks, an https Agent\'s options included. createServer refuses by name: orivon.net has no TLS listener.' },
  { specifier: 'tls', status: 'ready', kind: 'local', implementation: './net/tls.js', note: 'connect()/TLSSocket/checkServerIdentity over orivon.net.connectSecure, honouring ca, rejectUnauthorized, cert/key/pfx/passphrase, servername, ALPNProtocols and a custom checkServerIdentity. secureContext and STARTTLS over an existing socket refuse by name. See README.md and src/shim/net/tests/tls.test.ts.' },
  { specifier: 'net', status: 'ready', kind: 'local', implementation: './net/net.js', note: 'net.Socket (Node constructor, connect overloads, idle setTimeout, state accessors) and connect/createConnection over orivon.net.connect; net.Server/createServer over orivon.net.listen: a loopback host binds loopback only, no host asks for every interface and falls back to loopback under a local-only grant, any other host is refused by name; isIP/isIPv4/isIPv6. See src/shim/net/tests/{isip,server,socket,socket-rs3}.test.ts.' },
  { specifier: 'dgram', status: 'ready', kind: 'local', implementation: './net/dgram.js', note: 'createSocket over orivon.net.udpBind, built against k-rpc-socket\'s (bittorrent-dht\'s transport) call graph: events, address(), every send() overload validated as Node does, bind()\'s argument forms. See src/shim/net/tests/dgram-socket.test.ts.' },
  { specifier: 'dns', status: 'ready', kind: 'local', implementation: './net/dns.js', note: 'lookup/promises.lookup over orivon.net.lookup; an IP literal and localhost are answered locally. Every other dns member refuses by name. A denied resolution surfaces err.code === \'denied\'. See src/shim/net/tests/dns.test.ts.' },
  { specifier: 'fs', status: 'ready', kind: 'local', implementation: './fs/fs.js', note: 'readFile/writeFile/appendFile/access/unlink/mkdir/readdir/stat/rm/rmdir/rename/realpath as callback-style fs (fs/core.ts) and as fs.promises (fs/promises.ts) over the matching orivon.fs calls, sharing one core so the two surfaces cannot drift -- plus the real readFileSync/existsSync (ADR-0016) and fs.constants (fs/constants.ts). Every other *Sync export (statSync, lstatSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, rmSync, rmdirSync, renameSync, unlinkSync, accessSync, copyFileSync, mkdtempSync, realpathSync, openSync/readSync/writeSync/fstatSync/closeSync) works only in a Worker of a cross-origin isolated app, over its synchronous twin (fs/core-sync.ts, ADR-0016\'s amendment). rmdir/rmdirSync check for ENOENT/ENOTDIR/ENOTEMPTY over a stat and a readdir before removing anything, matching Node\'s legacy rmdir rather than riding rm\'s own EISDIR-on-any-directory failure; realpath/realpathSync/fs.promises.realpath answer locally from a stat, since orivon.fs never reports a symlink as its own kind. fs.open/fs.promises.open (fs/handle.ts) are real over orivon.fs.open -- a local cursor reconstructs Node\'s implicit `position: null` on top of the contract\'s deliberately explicit-position-only FileHandle; its fd table stays separate from openSync\'s own (fs/handle.ts\'s own doc comment says why a cross-family fd fails EBADF instead). fs.createReadStream/createWriteStream (fs/streams.ts) are real too, over that SAME local FileHandle, not the broker\'s readable()/writable() (still stuck at A184); FileHandle\'s own instance createReadStream/createWriteStream still refuse, citing A184. First confirmed caller: @seald-io/nedb\'s Node storage layer (src/shim/tests/nedb-storage.test.ts). See src/shim/fs/tests/*.test.ts.' },
  { specifier: 'buffer', status: 'ready', kind: 'local', implementation: './polyfills/buffer.js', note: `The \`buffer\` package (confirmed essential: bencode/safe-buffer; approved by the owner 2026-09-10, see ${REVIEW}), plus Blob/atob/btoa from the platform. Members it lacks refuse by name.` },
  { specifier: 'events', status: 'ready', kind: 'package', implementation: 'events', note: `Confirmed essential (k-bucket, k-rpc-socket, webtorrent's own import). Approved by the owner 2026-09-10; see ${REVIEW}.` },
  { specifier: 'path', status: 'ready', kind: 'local', implementation: './polyfills/path.js', note: `path-browserify (confirmed essential: webtorrent's own \`import path from 'path'\`; approved by the owner 2026-09-10, see ${REVIEW}), with posix pointing back at itself. Members it lacks (win32) refuse by name.` },
  { specifier: 'stream', status: 'ready', kind: 'package', implementation: 'stream-browserify', note: `Confirmed essential, transitively (crypto-browserify's Hash extends stream.Transform). Approved by the owner 2026-09-10; see ${REVIEW}.` },
  { specifier: 'crypto', status: 'ready', kind: 'local', implementation: './polyfills/crypto.js', note: `crypto-browserify (confirmed essential: bittorrent-protocol's mse.js, DH key exchange and sha1; approved by the owner 2026-09-10, see ${REVIEW}), plus webcrypto/subtle/getRandomValues/randomUUID from the platform. Members it lacks refuse by name.` },
  { specifier: 'os', status: 'ready', kind: 'local', implementation: './polyfills/os.js', note: `os-browserify's answers (approved by the owner 2026-09-10; see ${REVIEW}), with homedir()/tmpdir() at the virtual root (virtual-root.ts) and cpus() sized from navigator.hardwareConcurrency. Members os-browserify lacks refuse by name. See src/shim/polyfills/tests/os.test.ts.` },
  { specifier: 'zlib', status: 'ready', kind: 'local', implementation: './polyfills/zlib.js', note: `browserify-zlib (recon-flagged: FreeTube's main process; approved by the owner 2026-09-10, see ${REVIEW}). IMPORTANT: gzip/deflate only, via its pinned \`pako\`; browserify-zlib predates Node's brotli, so every brotli member refuses by name, and a real brotli need is a separate WASM-codec decision.` },
  { specifier: 'path/posix', status: 'ready', kind: 'local', implementation: './polyfills/path.js', note: 'The same module as \'path\', which is POSIX already.' },
  { specifier: 'fs/promises', status: 'ready', kind: 'local', implementation: './fs/promises.js', note: 'The same object as fs.promises.' },
  { specifier: 'stream/promises', status: 'ready', kind: 'local', implementation: './polyfills/stream-promises.js', note: 'The page stream\'s pipeline and finished, returning promises.' },
  { specifier: 'util/types', status: 'ready', kind: 'local', implementation: './polyfills/util-types.js', note: 'The same object as util.types.' },
  { specifier: 'dns/promises', status: 'ready', kind: 'local', implementation: './net/dns-promises.js', note: 'The same object as dns.promises.' },
  { specifier: 'timers', status: 'ready', kind: 'local', implementation: './polyfills/timers.js', note: 'Hand-written: the page\'s own timer functions, read at call time, and timers/promises.' },
  { specifier: 'timers/promises', status: 'ready', kind: 'local', implementation: './polyfills/timers-promises.js', note: 'Hand-written: setTimeout and setImmediate as promises, with AbortSignal.' },
  { specifier: 'url', status: 'ready', kind: 'local', implementation: './polyfills/url.js', note: 'Hand-written: the platform URL/URLSearchParams, fileURLToPath/pathToFileURL, and the legacy parse/format/resolve, checked against node:url.' },
  { specifier: 'querystring', status: 'ready', kind: 'local', implementation: './polyfills/querystring.js', note: 'Hand-written, checked against node:querystring.' },
  { specifier: 'string_decoder', status: 'ready', kind: 'local', implementation: './polyfills/string-decoder.js', note: 'Hand-written over TextDecoder\'s streaming mode, checked against node:string_decoder.' },
  { specifier: 'child_process', status: 'ready', kind: 'local', implementation: './child-process/index.js', note: 'A child is WebAssembly or JavaScript in a Worker, never an OS process (ADR-0040): spawn/execFile/exec run a WASI program from the app\'s bundle (a native program refuses as ENOEXEC, a missing one is ENOENT), fork runs an app module with process.send and an IPC channel. spawnSync/execSync/execFileSync work only in a Worker of a cross-origin isolated app, over a request kind of their own on its synchronous channel (spawn-sync.ts, ADR-0016\'s amendment); shell and uid/gid still refuse by name. See child-process/README.md.' },
  { specifier: 'module', status: 'ready', kind: 'local', implementation: './polyfills/module.js', note: 'createRequire loads a native addon by its .node path as its WebAssembly build over emnapi (addon/, ADR-0040), and any other relative or absolute path as a CommonJS file of the app\'s own fs (polyfills/cjs-loader.ts: exact name, .js, .cjs, .json, /index.js; a cache, cycles, require.resolve, a shim builtin by name). A bare name that is no builtin throws MODULE_NOT_FOUND: there is no node_modules resolution, since a bundle resolves its packages when it is built. A forked child also gets a global require of the same loader. builtinModules and isBuiltin answer from this table. Importing it also installs process.dlopen.' },
  { specifier: 'wasi', status: 'ready', kind: 'local', implementation: './wasi/node-wasi.js', note: 'Node\'s WASI class over the preview1 host in wasi/ (files, clocks, random, args/env, exit, over orivon.fs). start()/initialize() return promises (JSPI: the program suspends on each file call), and preopens name paths under the virtual root. Links, file times and sockets refuse by name. See wasi/README.md and src/shim/wasi/tests/.' },
  { specifier: 'worker_threads', status: 'ready', kind: 'local', implementation: './polyfills/worker-threads.js', note: 'Worker runs an app module as a thread over the same Web Workers child_process.fork uses (child-process/thread.ts): workerData, parentPort, postMessage, terminate(), ref()/unref(), online/message/messageerror/error/exit. isMainThread/threadId/parentPort/workerData/resourceLimits read what the thread itself set at evaluation time; MessageChannel/MessagePort are Node-shaped (worker/node-port.ts), BroadcastChannel is the platform\'s. eval, a nested thread, receiveMessageOnPort and moveMessagePortToContext refuse by name. See polyfills/tests/worker-threads-vm.test.ts and child-process/tests/thread.test.ts.' },
  { specifier: 'vm', status: 'ready', kind: 'local', implementation: './polyfills/vm.js', note: 'Hand-written: runInThisContext, Script#runInThisContext and compileFunction run in the page\'s own context, as indirect eval and new Function do under the served CSP\'s unsafe-eval. A context of its own needs a second realm, so createContext and the calls that enter one refuse by name. See polyfills/tests/worker-threads-vm.test.ts.' },
  { specifier: 'sqlite', status: 'ready', kind: 'local', implementation: './sqlite/index.js', prefixOnly: true, note: 'DatabaseSync and StatementSync over the SQLite WebAssembly engine (@sqlite.org/sqlite-wasm): exec, prepare, run/get/all/iterate with positional and named parameters, readBigInts, returnArrays, columns, transactions, and Node\'s error shapes. A database file is real, in the app\'s files with page-level I/O, and works only in a Worker of a cross-origin isolated app (a synchronous file call, ADR-0016\'s amendment); \':memory:\' works everywhere. The engine loads asynchronously, so a bundle imports sqlite/ready.ts first. function, aggregate, sessions, extensions, tag stores and backup refuse by name. See src/shim/sqlite/README.md.' },
  { specifier: 'process', status: 'ready', kind: 'local', implementation: './polyfills/process.js', note: 'The process global itself (require(\'process\') === process), with its function members as named exports that forward to the global at call time and its data members as the objects it holds at load. See polyfills/tests/process-module.test.ts.' },
  { specifier: 'assert', status: 'ready', kind: 'local', implementation: './polyfills/assert.js', note: 'Hand-written: ok/equal/strictEqual/deepEqual/deepStrictEqual/throws/rejects and their negations, AssertionError, assert.strict. Deep equality is polyfills/deep-equal.ts, shared with util.' },
  { specifier: 'tty', status: 'ready', kind: 'local', implementation: './polyfills/tty.js', note: 'isatty() is false for every descriptor, which is what libraries read to skip colour and prompts (supports-color, debug); ReadStream and WriteStream refuse by name, since an app has no terminal. See polyfills/tests/terminal-modules.test.ts.' },
  { specifier: 'readline', status: 'ready', kind: 'local', implementation: './polyfills/readline.js', note: 'Loads, so a library that only requires it at the top evaluates; every function (createInterface, Interface, cursorTo, ...) refuses by name. See polyfills/tests/terminal-modules.test.ts.' },
  { specifier: 'http2', status: 'ready', kind: 'local', implementation: './polyfills/http2.js', note: 'Loads with Node\'s real constants (polyfills/http2-constants.generated.json), which http2-wrapper and undici read as they evaluate; connect, createServer and every other function refuse by name, since orivon.net carries no HTTP/2 session. See polyfills/tests/http2.test.ts.' },
  { specifier: 'diagnostics_channel', status: 'ready', kind: 'local', implementation: './polyfills/diagnostics-channel.js', note: 'Real, pure JavaScript: channel/subscribe/unsubscribe/hasSubscribers, Channel#bindStore/runStores, and tracingChannel with traceSync/tracePromise/traceCallback. A throwing subscriber surfaces on the next tick, as in Node. See polyfills/tests/diagnostics-channel.test.ts.' },
  { specifier: 'async_hooks', status: 'ready', kind: 'local', implementation: './polyfills/async-hooks.js', note: 'AsyncResource (runInAsyncScope, bind, asyncId, triggerAsyncId) and AsyncLocalStorage (run, exit, enterWith, disable, getStore, bind, snapshot) over one table of current stores that a bound callback carries. A page has no per-continuation context, so a store does not follow an await or a timer nothing bound. createHook returns an inert hook: express\'s on-finished wraps every response in an AsyncResource and needs nothing more. See polyfills/tests/async-hooks.test.ts.' },
  { specifier: 'perf_hooks', status: 'ready', kind: 'local', implementation: './polyfills/perf-hooks.js', note: 'The platform\'s performance, PerformanceObserver and entry classes; the event-loop histograms refuse by name. See polyfills/tests/terminal-modules.test.ts.' },
  { specifier: 'console', status: 'ready', kind: 'local', implementation: './polyfills/console.js', note: 'The global console itself, with each named export forwarding to it at call time; Console is a real class, a console over a pair of writable streams (polyfills/console-class.ts), and the members Node has and the page lacks refuse by name. See polyfills/tests/terminal-modules.test.ts.' }
]

export interface ShimAliasEntry {
  readonly specifier: string
  readonly kind: 'local' | 'package'
  readonly implementation: string
  readonly prefixOnly?: boolean
}

/**
 * Matches `specifier` whole, bare or `node:`-prefixed, or only `node:`-prefixed for a `prefixOnly` row. Never a string alias:
 * Vite's string form also captures every subpath, rewriting `fs/promises` to
 * `<shim>/node-fs.js/promises`, which does not exist. A subpath is its own row.
 */
export function aliasPattern (specifier: string, prefixOnly = false): RegExp {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  return new RegExp(prefixOnly ? `^node:${escaped}$` : `^(?:node:)?${escaped}$`)
}

/** Every 'ready' row, in the shape electron.vite.config.ts resolves into its alias map. Silently drops every 'pending-dependency' row -- there is nothing yet to point an alias at. */
export function buildAliasEntries (): readonly ShimAliasEntry[] {
  const entries: ShimAliasEntry[] = []
  for (const entry of SHIM_MODULE_MAP) {
    if (entry.status !== 'ready' || entry.kind === undefined || entry.implementation === undefined) continue
    entries.push({ specifier: entry.specifier, kind: entry.kind, implementation: entry.implementation, ...(entry.prefixOnly === true ? { prefixOnly: true } : {}) })
  }
  return entries
}
