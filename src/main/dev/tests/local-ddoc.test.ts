import { describe, expect, it, vi } from 'vitest'
import { servesLocalDdoc } from '../local-ddoc.js'
import type { LocalDdocDeps } from '../local-ddoc.js'

const TREE = {
  bundleHash: 'sha256:' + 'a'.repeat(64),
  leaves: { '/index.html': 'sha256:' + 'b'.repeat(64) }
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

function deps (overrides: Partial<LocalDdocDeps> = {}): LocalDdocDeps {
  return { devMode: true, fetchCapped: async () => bytes(JSON.stringify(TREE)), ...overrides }
}

describe('servesLocalDdoc', () => {
  it('is true for a loopback origin in developer mode serving a readable tree, fetched from the well-known path', async () => {
    const fetchCapped = vi.fn(async () => bytes(JSON.stringify(TREE)))
    expect(await servesLocalDdoc('http://127.0.0.1:8875', deps({ fetchCapped }))).toBe(true)
    expect(fetchCapped).toHaveBeenCalledWith('http://127.0.0.1:8875/.well-known/orivon-ddoc.json', expect.any(Number))
  })

  it('accepts localhost and a developer .eth name over http', async () => {
    expect(await servesLocalDdoc('http://localhost:5173', deps())).toBe(true)
    expect(await servesLocalDdoc('http://freetube.eth', deps())).toBe(true)
  })

  it('is false outside developer mode, without fetching', async () => {
    const fetchCapped = vi.fn(async () => bytes(JSON.stringify(TREE)))
    expect(await servesLocalDdoc('http://127.0.0.1:8875', deps({ devMode: false, fetchCapped }))).toBe(false)
    expect(fetchCapped).not.toHaveBeenCalled()
  })

  it('is false for any origin that is not local, without fetching', async () => {
    const fetchCapped = vi.fn(async () => bytes(JSON.stringify(TREE)))
    for (const origin of ['https://app.example', 'http://app.example', 'https://freetube.eth', 'http://192.168.1.10:8080']) {
      expect(await servesLocalDdoc(origin, deps({ fetchCapped }))).toBe(false)
    }
    expect(fetchCapped).not.toHaveBeenCalled()
  })

  it('is false when the tree is missing, unreadable, or the index page a dev server answers every path with', async () => {
    for (const body of [null, bytes('{"bundleHash": "nope"}'), bytes('<!doctype html><title>app</title>'), bytes('')]) {
      expect(await servesLocalDdoc('http://127.0.0.1:8875', deps({ fetchCapped: async () => body }))).toBe(false)
    }
  })
})
