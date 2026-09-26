// Shared test fixtures for this directory's suites -- a stub Fetch and an
// in-memory LoaderStorage, plus the manifest JSON both fetch/tests/bundle.test.ts
// and index.test.ts need. Split out once index.test.ts needed the same
// stubFetch fetch/tests/bundle.test.ts had already built (docs/development/
// code-guidelines.md Rule 3), matching the `*.test-helpers.ts` pattern
// already used in src/broker/ (handles.test-helpers.ts, connect.test-
// helpers.ts). Not itself a `*.test.ts` file, so it carries no tests of its
// own -- only fixtures.

import { vi } from 'vitest'
import type { Resolver } from '../../broker/policy/connect.js'
import { parsePinRecord } from '../../broker/policy/pin.js'
import type { PinRecord } from '../../broker/policy/pin.js'
import { appRootDirectoryName } from '../cache/storage.js'
import { ddocToJson } from '../ddoc-declaration.js'
import type { DdocDeclaration } from '../ddoc-declaration.js'
import type { Fetch, FetchResponse } from '../fetch/budget.js'
import type { LoaderStorage, OpenedAsset } from '../cache/storage.js'

export const ORIGIN = 'https://app.example.com'
export const MANIFEST_URL = `${ORIGIN}/.well-known/orivon.json`

/** Resolves any hostname to one public-unicast literal -- the boring case for every test that isn't specifically about the T12/A46 install-origin guard. */
export const PUBLIC_RESOLVER: Resolver = async () => ['93.184.216.34']

export function manifestJson (overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    orivonApiVersion: 0,
    id: 'app.orivon.example',
    name: 'Example App',
    version: '1.0.0',
    entry: 'index.html',
    capabilities: {},
    ...overrides
  })
}

export function utf8 (text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

export interface RouteSpec {
  readonly status?: number
  /**
   * `response.url`. Defaults to the requested url, but fetch/bundle.ts no
   * longer reads this field at all (A141: real Electron's net.fetch reports
   * it as '' unconditionally) -- set here only so a test can assert the
   * field is genuinely inert, e.g. the A141 suite below setting it to ''.
   */
  readonly url?: string
  readonly body: Uint8Array
  readonly headers?: Record<string, string>
  /** Bytes per stream chunk -- defaults to 64 KiB, a realistic wire chunk size. Set smaller to see incremental caps bite sooner. */
  readonly chunkSize?: number
  /**
   * The body stream never ends -- `chunkSize` zero-bytes at a time, forever
   * (`body` is ignored). `arrayBuffer()` never resolves either, matching
   * what a real fetch's `arrayBuffer()` would do against an unbounded body
   * (it waits for the stream to finish). Models a chunked or compressed
   * attacker response with no Content-Length and no end, for the T11b
   * incremental-cap tests.
   */
  readonly infinite?: boolean
  /** The body stream's `pull()` never settles -- no bytes, no close, ever. Models a stalled connection, for the fetch-timeout tests. Mutually exclusive with `infinite`. */
  readonly stall?: boolean
}

function bodyStream (
  spec: RouteSpec,
  chunkSize: number,
  url: string,
  bodyReadSpy?: Set<string>,
  streamedBytesSpy?: Map<string, number>
): ReadableStream<Uint8Array> {
  let offset = 0
  return new ReadableStream<Uint8Array>({
    pull (controller) {
      bodyReadSpy?.add(url)
      if (spec.stall === true) return new Promise<void>(() => {})
      if (spec.infinite === true) {
        const chunk = new Uint8Array(chunkSize)
        streamedBytesSpy?.set(url, (streamedBytesSpy.get(url) ?? 0) + chunk.length)
        controller.enqueue(chunk)
        return undefined
      }
      if (offset >= spec.body.length) { controller.close(); return undefined }
      const end = Math.min(offset + chunkSize, spec.body.length)
      const chunk = spec.body.slice(offset, end)
      offset = end
      streamedBytesSpy?.set(url, (streamedBytesSpy.get(url) ?? 0) + chunk.length)
      controller.enqueue(chunk)
      return undefined
    }
    // `highWaterMark: 0` below matters more than it looks: a default
    // ReadableStream (highWaterMark 1) calls `pull()` once EAGERLY right
    // after construction, before any consumer ever calls `.read()` -- so
    // merely building this stub response would mark `bodyReadSpy`/
    // `streamedBytesSpy`, even down a code path that never reads the body
    // at all (the whole point of the Content-Length fast-path test below).
    // 0 suppresses that pre-fetch; an explicit `read()` still triggers
    // `pull()` normally, because a pending read request also counts
    // (WHATWG Streams `ReadableStreamDefaultControllerShouldCallPull`).
  }, { highWaterMark: 0 })
}

/**
 * A stub Fetch built from a routing table keyed by requested URL.
 * `bodyReadSpy`, when given, records which URLs actually had their body
 * stream pulled from -- so a test can prove a fail-fast path never read a
 * byte of a body it declared too large via Content-Length. `streamedBytesSpy`,
 * when given, records cumulative bytes actually pulled per URL -- so a test
 * can prove an oversized body was rejected long before it was read in full.
 */
export function stubFetch (
  routes: Record<string, RouteSpec>,
  bodyReadSpy?: Set<string>,
  streamedBytesSpy?: Map<string, number>
): Fetch {
  // `pinnedAddresses` is F2/F5's validated-literal hand-off (fetch/budget.ts's
  // own `Fetch` doc comment) -- this stub is a fake HTTP layer keyed by URL
  // string, with no real DNS/TCP underneath to pin, so it has nothing to do
  // with the argument beyond accepting it. Tests that care whether it was
  // threaded through correctly wrap this stub in their own spy (see
  // fetch/tests/bundle.test.ts's F2 and F5 suites) rather than this shared fixture
  // asserting anything about it.
  return async (url: string, _pinnedAddresses: readonly string[]): Promise<FetchResponse> => {
    const spec = routes[url]
    if (spec === undefined) throw new Error(`stubFetch: no route for ${url}`)
    const headers = spec.headers ?? {}
    const chunkSize = spec.chunkSize ?? 64 * 1024
    return {
      ok: (spec.status ?? 200) < 400,
      status: spec.status ?? 200,
      url: spec.url ?? url,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? headers[name] ?? null },
      body: bodyStream(spec, chunkSize, url, bodyReadSpy, streamedBytesSpy),
      arrayBuffer: async () => {
        if (spec.infinite === true || spec.stall === true) return await new Promise<ArrayBuffer>(() => {})
        bodyReadSpy?.add(url)
        return spec.body.buffer.slice(spec.body.byteOffset, spec.body.byteOffset + spec.body.byteLength) as ArrayBuffer
      }
    }
  }
}

export interface MemoryStorage extends LoaderStorage {
  /** Direct access for assertions -- never used by createLoader itself, only by tests inspecting what it wrote. */
  readonly pins: Map<string, unknown>
  readonly assets: Map<string, Map<string, Uint8Array>>
  /** Staged files, keyed `${origin} ${id}` -- a test can check nothing is left behind. */
  readonly staged: Map<string, Uint8Array>
}

function concatBytes (chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length }
  return out
}

/** `bytes` as an AssetStream, in 64 KiB chunks. */
export function streamOf (bytes: Uint8Array): { byteLength: number, chunks: AsyncIterable<Uint8Array> } {
  return {
    byteLength: bytes.length,
    chunks: (async function * () {
      for (let offset = 0; offset < bytes.length; offset += 64 * 1024) yield bytes.subarray(offset, offset + 64 * 1024)
    })()
  }
}

/** `bytes` opened as an OpenedAsset; its identity is the array object itself, so any rewrite of the Map entry is a new file. */
function openedAssetOf (bytes: Uint8Array, identity: string): OpenedAsset {
  return {
    byteLength: bytes.length,
    identity,
    read: async function * (start: number, end: number) {
      for (let offset = start; offset <= end; offset += 64 * 1024) yield bytes.subarray(offset, Math.min(offset + 64 * 1024, end + 1))
    },
    close: async () => {}
  }
}

/** A LoaderStorage backed by plain Maps -- no disk, no confinement, just enough to prove createLoader calls it correctly. */
export function memoryStorage (): MemoryStorage {
  const identities = new WeakMap<Uint8Array, string>()
  let nextIdentity = 0
  const pins = new Map<string, unknown>()
  const updateChecks = new Map<string, unknown>()
  const ddocs = new Map<string, unknown>()
  const assets = new Map<string, Map<string, Uint8Array>>()
  const staged = new Map<string, Uint8Array>()
  let nextId = 0
  const writeAsset = (origin: string, path: string, content: Uint8Array): void => {
    const forOrigin = assets.get(origin) ?? new Map<string, Uint8Array>()
    forOrigin.set(path, content)
    assets.set(origin, forOrigin)
  }
  return {
    pins,
    assets,
    staged,
    clearStaging: vi.fn(async (origin: string) => {
      for (const key of [...staged.keys()]) if (key.startsWith(`${origin} `)) staged.delete(key)
    }),
    openStaged: vi.fn(async (origin: string) => {
      const id = `staged-${String(nextId++)}`
      const chunks: Uint8Array[] = []
      return {
        id,
        write: async (chunk: Uint8Array) => { chunks.push(chunk.slice()) },
        close: async () => { staged.set(`${origin} ${id}`, concatBytes(chunks)) }
      }
    }),
    readStaged: vi.fn(async (origin: string, id: string) => {
      const bytes = staged.get(`${origin} ${id}`)
      return bytes === undefined ? undefined : streamOf(bytes)
    }),
    commitStaged: vi.fn(async (origin: string, id: string, path: string) => {
      const bytes = staged.get(`${origin} ${id}`)
      if (bytes === undefined) throw new Error(`nothing staged as ${id}`)
      staged.delete(`${origin} ${id}`)
      writeAsset(origin, path, bytes)
    }),
    readAssetStream: vi.fn(async (origin: string, path: string) => {
      const bytes = assets.get(origin)?.get(path)
      return bytes === undefined ? undefined : streamOf(bytes)
    }),
    openAsset: vi.fn(async (origin: string, path: string) => {
      const bytes = assets.get(origin)?.get(path)
      if (bytes === undefined) return undefined
      const identity = identities.get(bytes) ?? `memory-${String(nextIdentity++)}`
      identities.set(bytes, identity)
      return openedAssetOf(bytes, identity)
    }),
    readPin: vi.fn(async (origin: string) => pins.get(origin)),
    readUpdateCheck: vi.fn(async (origin: string) => updateChecks.get(origin)),
    writeUpdateCheck: vi.fn(async (origin: string, record: unknown) => {
      if (record === undefined) updateChecks.delete(origin)
      else updateChecks.set(origin, record)
    }),
    readDdoc: vi.fn(async (origin: string) => ddocs.get(origin)),
    // Held in its JSON form, as node-storage.ts writes it, so a read goes back through the parser.
    writeDdoc: vi.fn(async (origin: string, declaration: DdocDeclaration | undefined) => {
      if (declaration === undefined) ddocs.delete(origin)
      else ddocs.set(origin, JSON.parse(JSON.stringify(ddocToJson(declaration))))
    }),
    writePin: vi.fn(async (origin: string, record: PinRecord) => { pins.set(origin, record) }),
    writeAsset: vi.fn(async (origin: string, path: string, content: Uint8Array) => { writeAsset(origin, path, content) }),
    pruneAssets: vi.fn(async (origin: string, keep: readonly string[]) => {
      const forOrigin = assets.get(origin)
      if (forOrigin === undefined) return
      const keepSet = new Set(keep)
      for (const path of forOrigin.keys()) {
        if (!keepSet.has(path)) forOrigin.delete(path)
      }
    }),
    // The two serve.ts-era methods, added alongside src/loader/serve/serve.ts --
    // matching the SAME never-throws, undefined-on-anything-else contract
    // node-storage.ts's real implementation follows (storage.ts's own doc).
    readAsset: vi.fn(async (origin: string, path: string) => assets.get(origin)?.get(path)),
    listPinnedOrigins: vi.fn(async () => {
      const origins: string[] = []
      for (const [origin, raw] of pins) {
        const record = parsePinRecord(raw)
        if (record !== null && appRootDirectoryName(record.origin) === appRootDirectoryName(origin)) {
          origins.push(origin)
        }
      }
      return origins
    })
  }
}
