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
}

/**
 * A stub Fetch built from a routing table keyed by requested URL.
 * `bodyReadSpy`, when given, records which URLs actually had arrayBuffer()
 * called -- so a test can prove a fail-fast path never downloaded a body it
 * declared too large via Content-Length.
 */
export function stubFetch (routes: Record<string, RouteSpec>, bodyReadSpy?: Set<string>): Fetch {
  return async (url: string): Promise<FetchResponse> => {
    const spec = routes[url]
    if (spec === undefined) throw new Error(`stubFetch: no route for ${url}`)
    const headers = spec.headers ?? {}
    return {
      ok: (spec.status ?? 200) < 400,
      status: spec.status ?? 200,
      url: spec.url ?? url,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? headers[name] ?? null },
      arrayBuffer: async () => {
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
    })
  }
}
