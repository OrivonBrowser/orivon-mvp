// Shared test fixtures for this directory's suites -- a stub Fetch and an
// in-memory LoaderStorage, plus the manifest JSON both fetch-bundle.test.ts
// and index.test.ts need. Split out once index.test.ts needed the same
// stubFetch fetch-bundle.test.ts had already built (docs/development/
// code-guidelines.md Rule 3), matching the `*.test-helpers.ts` pattern
// already used in src/broker/ (handles.test-helpers.ts, connect.test-
// helpers.ts). Not itself a `*.test.ts` file, so it carries no tests of its
// own -- only fixtures.

import { vi } from 'vitest'
import type { PinRecord } from '../broker/policy/pin.js'
import type { Fetch, FetchResponse } from './fetch-bundle.js'
import type { LoaderStorage } from './storage.js'

export const ORIGIN = 'https://app.example.com'
export const MANIFEST_URL = `${ORIGIN}/.well-known/orivon.json`

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
  /** Final response.url, defaults to the requested url -- set to something else to simulate a redirect. */
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
  return async (url: string): Promise<FetchResponse> => {
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
}

/** A LoaderStorage backed by plain Maps -- no disk, no confinement, just enough to prove createLoader calls it correctly. */
export function memoryStorage (): MemoryStorage {
  const pins = new Map<string, unknown>()
  const assets = new Map<string, Map<string, Uint8Array>>()
  return {
    pins,
    assets,
    readPin: vi.fn(async (origin: string) => pins.get(origin)),
    writePin: vi.fn(async (origin: string, record: PinRecord) => { pins.set(origin, record) }),
    writeAsset: vi.fn(async (origin: string, path: string, content: Uint8Array) => {
      const forOrigin = assets.get(origin) ?? new Map<string, Uint8Array>()
      forOrigin.set(path, content)
      assets.set(origin, forOrigin)
    }),
    pruneAssets: vi.fn(async (origin: string, keep: readonly string[]) => {
      const forOrigin = assets.get(origin)
      if (forOrigin === undefined) return
      const keepSet = new Set(keep)
      for (const path of forOrigin.keys()) {
        if (!keepSet.has(path)) forOrigin.delete(path)
      }
    })
  }
}
