import { describe, expect, it } from 'vitest'
import {
  bundleHash,
  canonicalAssetPath,
  MANIFEST_PATH,
  MAX_ASSET_BYTES,
  MAX_BUNDLE_BYTES,
  type BundleEntry
} from './bundle-hash.js'

function utf8 (text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function manifestEntry (content = '{"orivonApiVersion":0}'): BundleEntry {
  return { path: MANIFEST_PATH, content: utf8(content) }
}

// ===========================================================================
// FROZEN GOLDEN VECTORS -- DO NOT REGENERATE.
//
// If a change to bundle-hash.ts makes a row below fail, THE CHANGE IS WRONG.
// Do not "fix" a vector by re-running the code and pasting the new hash. That
// converts a caught bug into a shipped one -- see ADR-0009: this construction
// is a one-way door once the first pin is persisted, so a silent drift here
// invalidates every pin already issued and orphans every attestation.
//
// Provenance: computed 2026-08-26 by an INDEPENDENT reference implementation
// (node:crypto's createHash, not this file) -- see
// docs/architecture/bundle-hash.md for the script and every vector's
// reasoning. The table cannot be a recording of this implementation's own
// bugs.
// ===========================================================================

describe('frozen golden vectors', () => {
  it('V1: three-file bundle including the manifest', async () => {
    const entries: BundleEntry[] = [
      manifestEntry(),
      { path: '/index.html', content: utf8('<!doctype html><title>a</title>') },
      { path: '/app.js', content: utf8('console.log(1)') }
    ]
    await expect(bundleHash(entries)).resolves.toBe(
      'sha256:2ff5baaa794301118be4270755686fd1438501332ab3b1a199af90815ca4c4fd'
    )
  })

  it('V2: same set, shuffled input order, must match V1', async () => {
    const entries: BundleEntry[] = [
      { path: '/app.js', content: utf8('console.log(1)') },
      manifestEntry(),
      { path: '/index.html', content: utf8('<!doctype html><title>a</title>') }
    ]
    await expect(bundleHash(entries)).resolves.toBe(
      'sha256:2ff5baaa794301118be4270755686fd1438501332ab3b1a199af90815ca4c4fd'
    )
  })

  it('V3: single-leaf bundle -- root must NOT equal the leaf digest', async () => {
    const entries: BundleEntry[] = [manifestEntry('{}')]
    await expect(bundleHash(entries)).resolves.toBe(
      'sha256:d7cc8d092809e3f091d7f11a7dcccfceba519540a5f5730f80068b371b358e25'
    )
  })

  it('V4: injectivity -- {a:"bc"} vs {ab:"c"} must differ', async () => {
    // Both bundles get a manifest leaf appended so bundleHash() does not
    // reject them for missing one; the vector's subject is the OTHER leaf.
    const a: BundleEntry[] = [manifestEntry(), { path: '/a', content: utf8('bc') }]
    const b: BundleEntry[] = [manifestEntry(), { path: '/ab', content: utf8('c') }]
    const [hashA, hashB] = await Promise.all([bundleHash(a), bundleHash(b)])
    expect(hashA).not.toBe(hashB)
  })

  it('V5: UTF-8 byte order vs UTF-16 code-unit order', async () => {
    const entries: BundleEntry[] = [
      manifestEntry(),
      { path: '/\u{10000}.js', content: utf8('x') }, // supplementary plane
      { path: '/.js', content: utf8('y') } // BMP private-use area
    ]
    await expect(bundleHash(entries)).resolves.toBe(
      'sha256:2cb9aeca099886230482a7d8ea0fb3338aaf146466f301817c42f81306a8d53c'
    )
  })
})

describe('order independence', () => {
  it('is insensitive to input array order beyond the two frozen vectors', async () => {
    const a = manifestEntry()
    const b: BundleEntry = { path: '/z.js', content: utf8('z') }
    const c: BundleEntry = { path: '/a.js', content: utf8('a') }
    const forward = await bundleHash([a, b, c])
    const reversed = await bundleHash([c, b, a])
    const shuffled = await bundleHash([b, a, c])
    expect(forward).toBe(reversed)
    expect(forward).toBe(shuffled)
  })
})

describe('rejected before hashing', () => {
  it('a bundle with zero entries', async () => {
    await expect(bundleHash([])).rejects.toMatchObject({ code: 'invalid' })
  })

  it('a bundle missing the manifest leaf', async () => {
    await expect(
      bundleHash([{ path: '/index.html', content: utf8('x') }])
    ).rejects.toMatchObject({ code: 'invalid' })
  })

  it('two paths colliding under case folding', async () => {
    await expect(
      bundleHash([
        manifestEntry(),
        { path: '/App.js', content: utf8('1') },
        { path: '/app.js', content: utf8('2') }
      ])
    ).rejects.toMatchObject({ code: 'invalid' })
  })

  it('two paths colliding under NFC/NFD normalisation', async () => {
    // 'é' as a single codepoint (NFC) vs 'e' + combining acute accent (NFD).
    const nfc = '/café.js'
    const nfd = '/café.js'
    expect(nfc).not.toBe(nfd) // distinct byte strings going in
    await expect(
      bundleHash([manifestEntry(), { path: nfc, content: utf8('1') }, { path: nfd, content: utf8('2') }])
    ).rejects.toMatchObject({ code: 'invalid' })
  })

  it('an exact duplicate path', async () => {
    await expect(
      bundleHash([manifestEntry(), { path: '/a.js', content: utf8('1') }, { path: '/a.js', content: utf8('2') }])
    ).rejects.toMatchObject({ code: 'invalid' })
  })

  it('a path not starting with /', async () => {
    await expect(
      bundleHash([manifestEntry(), { path: 'a.js', content: utf8('x') }])
    ).rejects.toMatchObject({ code: 'invalid' })
  })

  it('a path with a .. segment', async () => {
    await expect(
      bundleHash([manifestEntry(), { path: '/a/../b.js', content: utf8('x') }])
    ).rejects.toMatchObject({ code: 'invalid' })
  })

  it('a path with a . segment', async () => {
    await expect(
      bundleHash([manifestEntry(), { path: '/a/./b.js', content: utf8('x') }])
    ).rejects.toMatchObject({ code: 'invalid' })
  })

  it('a path containing a NUL byte', async () => {
    await expect(
      bundleHash([manifestEntry(), { path: '/a' + '\u0000' + 'b.js', content: utf8('x') }])
    ).rejects.toMatchObject({ code: 'invalid' })
  })

  it('a path containing a C0 control character', async () => {
    await expect(
      bundleHash([manifestEntry(), { path: '/a' + '\u0001' + 'b.js', content: utf8('x') }])
    ).rejects.toMatchObject({ code: 'invalid' })
  })

  it('an asset exceeding MAX_ASSET_BYTES', async () => {
    const oversized: BundleEntry = { path: '/big.bin', content: new Uint8Array(MAX_ASSET_BYTES + 1) }
    await expect(bundleHash([manifestEntry(), oversized])).rejects.toMatchObject({ code: 'invalid' })
  })

  it('a bundle exceeding MAX_BUNDLE_BYTES in aggregate', async () => {
    const chunk = Math.floor(MAX_ASSET_BYTES / 2)
    const entries: BundleEntry[] = [manifestEntry()]
    let total = 0
    let i = 0
    while (total <= MAX_BUNDLE_BYTES) {
      entries.push({ path: `/chunk-${i}.bin`, content: new Uint8Array(chunk) })
      total += chunk
      i += 1
    }
    await expect(bundleHash(entries)).rejects.toMatchObject({ code: 'invalid' })
  })
})

describe('canonicalAssetPath', () => {
  it('preserves percent-encoding rather than decoding it', () => {
    expect(canonicalAssetPath('https://x.example/a%2Fb/c.js')).toBe('/a%2Fb/c.js')
  })

  it('percent-encodes non-ASCII bytes as UTF-8', () => {
    expect(canonicalAssetPath('https://x.example/ä/\u{1f642}.js')).toBe(
      '/%C3%A4/%F0%9F%99%82.js'
    )
  })

  it('preserves path case rather than folding it', () => {
    expect(canonicalAssetPath('https://x.example/App.js')).toBe('/App.js')
  })

  it('is idempotent: re-deriving from its own output is a no-op', () => {
    const once = canonicalAssetPath('https://x.example/a%2Fb/ä.js')
    expect(once).not.toBeNull()
    const twice = canonicalAssetPath(`https://x.example${once!}`)
    expect(twice).toBe(once)
  })

  it('returns null for an unparseable URL', () => {
    expect(canonicalAssetPath('not a url')).toBeNull()
  })

  it('rejects an over-length path', () => {
    const longPath = '/' + 'a'.repeat(2000) + '.js'
    expect(canonicalAssetPath(`https://x.example${longPath}`)).toBeNull()
  })
})
