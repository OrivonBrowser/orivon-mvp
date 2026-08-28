import { describe, expect, it } from 'vitest'
import { bundleHash, bundleTree, MAX_ASSET_BYTES, MAX_BUNDLE_BYTES, type BundleEntry } from './bundle-hash.js'
import { MANIFEST_PATH, MAX_BUNDLE_ENTRIES } from './canonical-path.js'
import { manifestEntry, utf8 } from './bundle-hash.test-helpers.js'

// The root/tree-construction half of the bundle hash's suite (split out of
// one file that exceeded docs/development/code-guidelines.md's 800-line
// test limit -- see ./canonical-path.test.ts for the path-validation half,
// which moved with canonical-path.ts in the same split).

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

  // REVISED 2026-08-27, before any pin was ever persisted -- see
  // bundle-hash.md SSV5 and ADR-0009's amendment. The original V5 hashed RAW
  // supplementary-plane and private-use characters in its paths. Those are not
  // canonical paths, and bundleTree() now rejects them: new URL() always
  // percent-encodes non-ASCII, so no fetched asset can ever present that form.
  // Re-expressed here in the form a browser actually produces. Root recomputed
  // by the same independent node:crypto reference implementation as the rest of
  // this table, never by the implementation under test.
  //
  // Note what the re-expression costs: once every path is percent-encoded it is
  // pure ASCII, so UTF-8 byte order and UTF-16 code-unit order CANNOT diverge.
  // This vector no longer proves the sort rule -- nothing reachable can. See
  // compareUtf8Bytes in ./bundle-hash.ts for why it is kept regardless.
  it('V5: non-ASCII paths hash in their percent-encoded form', async () => {
    const entries: BundleEntry[] = [
      manifestEntry(),
      { path: '/%F0%90%80%80.js', content: utf8('x') }, // U+10000, supplementary plane
      { path: '/%EE%80%80.js', content: utf8('y') } // U+E000, BMP private-use area
    ]
    await expect(bundleHash(entries)).resolves.toBe(
      'sha256:9aebeec88db79ddc4244d8026f0f93aee26d8bcd686da283c77db35617467af9'
    )
  })

  // V6 freezes what V1-V5 do not: the PER-LEAF digests. pin.ts persists these
  // as the pinned asset set, so they are as much a one-way door as the root --
  // ADR-0009's reasoning applies to them verbatim, and until now nothing held
  // them still. Same independent reference implementation.
  it('V6: the per-path leaf table for V1, in sorted order', async () => {
    const entries: BundleEntry[] = [
      manifestEntry(),
      { path: '/index.html', content: utf8('<!doctype html><title>a</title>') },
      { path: '/app.js', content: utf8('console.log(1)') }
    ]
    await expect(bundleTree(entries)).resolves.toEqual({
      root: 'sha256:2ff5baaa794301118be4270755686fd1438501332ab3b1a199af90815ca4c4fd',
      assets: [
        {
          path: '/.well-known/orivon.json',
          leaf: 'sha256:612c226ad5f32daa98f31de474342d9f6215339cc7f607b5052bbf57e0422872'
        },
        {
          path: '/app.js',
          leaf: 'sha256:fe2c01feec61bdeccff4b903bfca12c534a3c770d053bcdb6e7171ec60a41116'
        },
        {
          path: '/index.html',
          leaf: 'sha256:e64a531c45ee108a04ea6ba8d43eb74810b50142a6f68d6d37a4f73389cc6975'
        }
      ]
    })
  })

  // The leaf digest bundle-hash.md publishes beside V3's root, which nothing
  // held until V6 made the leaf table a frozen output.
  it("V3's published leaf digest, and root-vs-leaf domain separation", async () => {
    const tree = await bundleTree([manifestEntry('{}')])
    expect(tree.assets).toEqual([
      {
        path: MANIFEST_PATH,
        leaf: 'sha256:4c1f4a74edebb25f62e547b5741793f5f759fdadd631fac073557ef8e78e5deb'
      }
    ])
    expect(tree.root).not.toBe(tree.assets[0]!.leaf)
  })
})

// A DELIBERATELY UNTESTED PROPERTY, recorded so nobody spends an afternoon
// trying to cover it. Replacing compareUtf8Bytes with Array.prototype.sort's
// default UTF-16 comparison passes this entire suite, and that is not a gap:
// isValidCanonicalPath now requires canonical form, canonical paths are pure
// ASCII, and for ASCII the two orders are IDENTICAL. No legal bundle can tell
// them apart, so no vector can either -- V5's re-expression removed the last
// input that could. See compareUtf8Bytes in ./bundle-hash.ts for why the
// stricter comparator is kept anyway.
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

describe('rejected before hashing (bundle structure, not path validity)', () => {
  it('a bundle with zero entries', async () => {
    await expect(bundleHash([])).rejects.toMatchObject({ code: 'invalid' })
  })

  it('a bundle missing the manifest leaf', async () => {
    await expect(
      bundleHash([{ path: '/index.html', content: utf8('x') }])
    ).rejects.toMatchObject({ code: 'invalid' })
  })

  it('a bundle with more than MAX_BUNDLE_ENTRIES leaves', async () => {
    const entries: BundleEntry[] = [manifestEntry()]
    for (let i = 0; i <= MAX_BUNDLE_ENTRIES; i += 1) {
      entries.push({ path: `/f${i}`, content: new Uint8Array(0) })
    }
    await expect(bundleHash(entries)).rejects.toMatchObject({ code: 'invalid' })
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
