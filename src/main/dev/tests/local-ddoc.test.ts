import { describe, expect, it, vi } from 'vitest'
import { localDdocHash } from '../local-ddoc.js'
import type { LocalDdocDeps } from '../local-ddoc.js'

const TREE = {
  bundleHash: 'sha256:' + 'a'.repeat(64),
  leaves: { '/index.html': 'sha256:' + 'b'.repeat(64) }
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

function deps (overrides: Partial<LocalDdocDeps> = {}): LocalDdocDeps {
  return { devMode: true, fetchCapped: async () => bytes(JSON.stringify(TREE)), ...overrides }
}

describe('localDdocHash', () => {
  it('is the declared bundle hash for a loopback origin in developer mode serving a readable tree, fetched from the well-known path', async () => {
    const fetchCapped = vi.fn(async () => bytes(JSON.stringify(TREE)))
    expect(await localDdocHash('http://127.0.0.1:8875', deps({ fetchCapped }))).toBe(TREE.bundleHash)
    expect(fetchCapped).toHaveBeenCalledWith('http://127.0.0.1:8875/.well-known/orivon-ddoc.json', expect.any(Number))
  })

  it('accepts localhost and a developer .eth name over http', async () => {
    expect(await localDdocHash('http://localhost:5173', deps())).toBe(TREE.bundleHash)
    expect(await localDdocHash('http://freetube.eth', deps())).toBe(TREE.bundleHash)
  })

  it('is undefined outside developer mode, without fetching', async () => {
    const fetchCapped = vi.fn(async () => bytes(JSON.stringify(TREE)))
    expect(await localDdocHash('http://127.0.0.1:8875', deps({ devMode: false, fetchCapped }))).toBeUndefined()
    expect(fetchCapped).not.toHaveBeenCalled()
  })

  it('is undefined for any origin that is not local, without fetching', async () => {
    const fetchCapped = vi.fn(async () => bytes(JSON.stringify(TREE)))
    for (const origin of ['https://app.example', 'http://app.example', 'https://freetube.eth', 'http://192.168.1.10:8080']) {
      expect(await localDdocHash(origin, deps({ fetchCapped }))).toBeUndefined()
    }
    expect(fetchCapped).not.toHaveBeenCalled()
  })

  it('is undefined when the tree is missing, unreadable, or the index page a dev server answers every path with', async () => {
    for (const body of [null, bytes('{"bundleHash": "nope"}'), bytes('<!doctype html><title>app</title>'), bytes('')]) {
      expect(await localDdocHash('http://127.0.0.1:8875', deps({ fetchCapped: async () => body }))).toBeUndefined()
    }
  })
})
