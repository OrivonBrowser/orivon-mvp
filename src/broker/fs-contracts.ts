// `orivon.fs`'s own vocabulary -- pure type declarations, split out of
// ./broker-contracts.ts (code-guidelines.md Rule 2) once `open`'s types
// pushed that file past 500 lines. Concern-based, matching that file's own
// precedent (net's types stayed there; the split here is by SUBSYSTEM, the
// same test net-capability.ts's own move out of ./index.ts applied one
// layer up). Re-exported from broker-contracts.ts, so no import site
// elsewhere needed to change.

import type { DestroyResource, FailableFileHandle } from './handles/handle-contracts.js'

/** What `fs.stat` reports. Mirrors `contracts/handles.ts`'s `FileStat` exactly -- one shape, not redeclared. */
export interface RawFileStat {
  size: number
  isFile: boolean
  isDirectory: boolean
  mtimeMs: number
}

/**
 * What `orivon.fs.open` needs from a real open file descriptor, minus the
 * handle-table bookkeeping (`id`/`closed`/`close()`) `createBroker` supplies
 * once it is registered -- `DialedSocket`'s fs counterpart.
 *
 * `readable`/`writable` are ALREADY REAL WHATWG streams by the time this
 * shape is satisfied (`./adapters/node-fs-adapter.js`, `Readable.toWeb`/
 * `Writable.toWeb` over the same fd, matching `node-adapters.ts`'s own
 * `dialOne` -- see that file's header for why building the real stream at
 * the adapter layer, before any transport wiring exists, is the pattern
 * this follows rather than a new one).
 */
export interface OpenedFile {
  /** Short read at EOF -- returns exactly `bytesRead` bytes, never padded. */
  read(opts: { position: number, length: number }): Promise<Uint8Array>
  /** Returns bytes written. */
  write(opts: { position: number, data: Uint8Array }): Promise<number>
  readable(opts?: { start?: number, end?: number }): ReadableStream<Uint8Array>
  writable(opts?: { start?: number }): WritableStream<Uint8Array>
  stat(): Promise<RawFileStat>
  truncate(length: number): Promise<void>
  sync(): Promise<void>
  /** Matches HandleTable's DestroyResource exactly -- `acquire()` uses it directly as the handle's destroy callback. */
  readonly destroy: DestroyResource
}

/**
 * What `orivon.fs` needs from the real filesystem. `policy/paths.ts` stays
 * pure; this is the one seam where confinement's decision touches disk.
 *
 * Every method below receives an ALREADY-CONFINED absolute path (or two, for
 * `rename`) -- `./fs-capability.ts` is the only caller, and it never hands
 * this interface anything that has not already passed `confinePath`. This
 * layer's job is raw I/O, nothing else.
 */
export interface BrokerFs {
  /**
   * The absolute directory `origin`'s files are confined to. Computed by the
   * INJECTED implementation, not here: security-model.md T13b makes it
   * `sha256(canonical origin)` under the app data directory, and that
   * directory lives outside anything this pure-orchestration layer knows --
   * there is no `electron`, and no user-data path, in createBroker's fixed
   * dependency shape. AI recommendation, not an owner decision: nothing in
   * the corpus specifies which side of this seam computes the root.
   */
  rootFor(origin: string): string
  /** `confinePath`'s `realpath` parameter (policy/paths.ts). Synchronous, matching node:fs's `realpathSync`. */
  realpathSync(path: string): string
  readFile(path: string): Promise<Uint8Array>
  writeFile(path: string, data: Uint8Array): Promise<void>
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>
  readdir(path: string): Promise<readonly string[]>
  stat(path: string): Promise<RawFileStat>
  /** `force` is never exposed above this layer -- a missing path surfaces ENOENT, mapped to `notFound`, the same as every other fs call. */
  rm(path: string, opts?: { recursive?: boolean }): Promise<void>
  rename(from: string, to: string): Promise<void>
  /**
   * Opens `path` (already confined) with the given Node-shaped flags string
   * ('r', 'w', 'a', 'r+', ...) and returns a live descriptor -- `Dial`'s
   * counterpart for `orivon.fs.open`, minus the handle-table bookkeeping
   * `createBroker` supplies once it is registered. No `signal` parameter,
   * unlike `Dial`: opening a local file is a fast syscall with nothing
   * resembling `Dial`'s DNS-plus-handshake latency, matching `readFile`/
   * `writeFile` above, which take no signal either.
   */
  open(path: string, flags: string): Promise<OpenedFile>
}

/**
 * `Broker['fs']` -- the app-facing surface `../broker-contracts.js`'s
 * `Broker` interface exposes, factored out here alongside the types it is
 * built from rather than left inline once `open` joined it.
 */
export interface BrokerFsMethods {
  readFile(origin: string, path: string): Promise<Uint8Array>
  writeFile(origin: string, path: string, data: Uint8Array): Promise<void>
  /**
   * ADR-0016's synchronous entry point: the SAME grant check and path
   * confinement `readFile`/`writeFile` use (`./fs-capability.ts`'s
   * `confineForOrigin`), exposed synchronously for `orivon.fs.
   * readFileSync`'s main-process handler (`./transport/sync-fs.ts`),
   * which cannot await a Promise on this path. Returns the confined
   * absolute path; throws an OrivonError ('denied') on refusal. Does NOT
   * run under the per-origin in-flight budget `readFile`/`writeFile` do
   * -- see `./fs-capability.ts`'s own doc on `confineSync` for why that
   * budget is `async`-shaped and this call, by ADR-0016's own design, is
   * not.
   */
  confineSync(origin: string, path: string): string
  /**
   * Confined the same way `readFile`/`writeFile` are (`./fs-capability.ts`'s
   * `confineForOrigin`) and run under the same per-origin in-flight budget
   * (`runFsIo`). `recursive: true` matches `node:fs/promises.mkdir`'s own
   * flag; omitted or `false`, a missing parent yields `notFound` (mapped
   * ENOENT), the same failure shape every other fs call already produces.
   */
  mkdir(origin: string, path: string, opts?: { recursive?: boolean }): Promise<void>
  /** Confined and budgeted like `readFile`. Entry NAMES only, never full paths -- matching `contracts/capability-api.ts`'s `Promise<readonly string[]>`. */
  readdir(origin: string, path: string): Promise<readonly string[]>
  /** Confined and budgeted like `readFile`. Mirrors `contracts/handles.ts`'s `FileStat` shape exactly. */
  stat(origin: string, path: string): Promise<RawFileStat>
  /**
   * Confined and budgeted like `writeFile`, but reserves no quota: quota
   * tracks bytes WRITTEN (`fs.writeFile`'s own doc), and deleting is never
   * a write. `recursive: true` matches `node:fs/promises.rm`; `force` is
   * never exposed -- a missing path yields `notFound`, same as every other
   * fs call.
   */
  rm(origin: string, path: string, opts?: { recursive?: boolean }): Promise<void>
  /**
   * BOTH `from` AND `to` are independently confined before anything on
   * disk moves -- see `./fs-capability.ts`'s own doc for why a check on
   * `from` alone would turn this into an arbitrary-write primitive. Runs
   * under `from`'s in-flight budget slot (the same grant authorises both
   * paths, so either would do).
   */
  rename(origin: string, from: string, to: string): Promise<void>
  /**
   * Confined once, at open, exactly like every other `fs` method --
   * `./fs-capability.ts`'s own header explains why a positional `read`/
   * `write` against the handle this returns needs no SECOND confinement
   * check: both go through the real OS file descriptor this call opens,
   * never through the path again, so there is nothing left to re-resolve.
   * Runs under the same per-origin in-flight budget `readFile`/`writeFile`
   * do while OPENING; each operation against the handle it returns runs
   * under its own handle-scoped budget instead (`./fs-capability.ts`'s
   * `runFileIo`), the same distinction `net.connect` (acquisition) draws
   * against reads/writes on the socket it returns.
   */
  open(origin: string, path: string, flags: string): Promise<FailableFileHandle>
}
