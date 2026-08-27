import { describe, expect, it } from 'vitest'
import { MANIFEST_PATH, MAX_BUNDLE_ENTRIES } from './bundle-hash.js'
import { fromBundleTree, isPinnedPath, parsePinRecord, type PinRecord } from './pin.js'

const VALID_HASH = 'sha256:2ff5baaa794301118be4270755686fd1438501332ab3b1a199af90815ca4c4fd'
const OTHER_HASH = 'sha256:d7cc8d092809e3f091d7f11a7dcccfceba519540a5f5730f80068b371b358e25'

// Every pin record needs a leaf at the reserved manifest path, exactly as
// every bundle does -- fromBundleTree and parsePinRecord both enforce it, so
// a fixture without one tests nothing reachable.
const MANIFEST_LEAF = { path: MANIFEST_PATH, leaf: OTHER_HASH }

function validRaw (): Record<string, unknown> {
  return {
    schema: 1,
    origin: 'https://app.example.com',
    bundleHash: VALID_HASH,
    assets: [
      { path: '/.well-known/orivon.json', leaf: OTHER_HASH },
      { path: '/index.html', leaf: OTHER_HASH }
    ],
    version: '0.1.0',
    pinnedAt: 1_700_000_000_000
  }
}

describe('parsePinRecord: accepts a well-formed record', () => {
  it('round-trips every field', () => {
    const record = parsePinRecord(validRaw())
    expect(record).toEqual({
      schema: 1,
      origin: 'https://app.example.com',
      bundleHash: VALID_HASH,
      assets: [
        { path: '/.well-known/orivon.json', leaf: OTHER_HASH },
        { path: '/index.html', leaf: OTHER_HASH }
      ],
      version: '0.1.0',
      pinnedAt: 1_700_000_000_000
    })
  })
})

describe('parsePinRecord: never throws, denies by returning null', () => {
  it('a non-object', () => {
    expect(parsePinRecord(null)).toBeNull()
    expect(parsePinRecord(undefined)).toBeNull()
    expect(parsePinRecord('a string')).toBeNull()
    expect(parsePinRecord(42)).toBeNull()
    expect(parsePinRecord([])).toBeNull()
  })

  it('the wrong schema version', () => {
    expect(parsePinRecord({ ...validRaw(), schema: 2 })).toBeNull()
    expect(parsePinRecord({ ...validRaw(), schema: '1' })).toBeNull()
  })

  it('a missing field', () => {
    for (const key of ['schema', 'origin', 'bundleHash', 'assets', 'version', 'pinnedAt']) {
      const raw = validRaw()
      delete raw[key]
      expect(parsePinRecord(raw), `missing ${key}`).toBeNull()
    }
  })

  it('an empty origin', () => {
    expect(parsePinRecord({ ...validRaw(), origin: '' })).toBeNull()
  })

  // `origin` is the field that says which app a pin belongs to, and it is
  // matched against Grant.origin. Until origin.ts landed on main there was no
  // canonical definition to hold it to and any non-empty string passed. Same
  // stance as the asset paths: already-canonical or rejected, never repaired --
  // a pin spelled differently from the grant ledger's spelling of the same
  // origin is a bug, and silently normalising it here would hide it.
  it('an origin that is not already a canonical origin', () => {
    for (const origin of [
      'not-an-origin',
      'https://app.example.com/', // trailing slash
      'https://app.example.com/path', // a path is not part of an origin
      'https://x.example.', // trailing DNS dot: one origin, but spelled the other way (A14)
      'HTTPS://app.example.com', // scheme case
      'file:///etc/passwd',
      'https://user:pw@app.example.com'
    ]) {
      expect(
        parsePinRecord({ ...validRaw(), origin }),
        `should refuse ${JSON.stringify(origin)}`
      ).toBeNull()
    }
  })

  it('the canonical origin forms that must be accepted', () => {
    for (const origin of ['https://app.example.com', 'https://x.example:8443', 'http://localhost:5173']) {
      expect(parsePinRecord({ ...validRaw(), origin })?.origin, origin).toBe(origin)
    }
  })

  it('a bundleHash that is not sha256:<64 lowercase hex>', () => {
    expect(parsePinRecord({ ...validRaw(), bundleHash: 'not-a-hash' })).toBeNull()
    expect(parsePinRecord({ ...validRaw(), bundleHash: VALID_HASH.toUpperCase() })).toBeNull()
    expect(parsePinRecord({ ...validRaw(), bundleHash: VALID_HASH.slice(0, -1) })).toBeNull()
    expect(parsePinRecord({ ...validRaw(), bundleHash: `md5:${'a'.repeat(32)}` })).toBeNull()
  })

  it('assets that is not an array', () => {
    expect(parsePinRecord({ ...validRaw(), assets: {} })).toBeNull()
    expect(parsePinRecord({ ...validRaw(), assets: 'nope' })).toBeNull()
  })

  // Each carries the manifest leaf so the subject of the test is the ONLY
  // reason to reject -- see the note on the canonical-path case below.
  it('an asset entry missing path or leaf, or with a bad leaf shape', () => {
    expect(parsePinRecord({ ...validRaw(), assets: [MANIFEST_LEAF, { leaf: OTHER_HASH }] })).toBeNull()
    expect(parsePinRecord({ ...validRaw(), assets: [MANIFEST_LEAF, { path: '/a' }] })).toBeNull()
    expect(parsePinRecord({ ...validRaw(), assets: [MANIFEST_LEAF, { path: '/a', leaf: 'bad' }] })).toBeNull()
    expect(parsePinRecord({ ...validRaw(), assets: [MANIFEST_LEAF, '/a'] })).toBeNull()
  })

  it('an empty asset path', () => {
    expect(parsePinRecord({ ...validRaw(), assets: [MANIFEST_LEAF, { path: '', leaf: OTHER_HASH }] })).toBeNull()
  })

  // A pin record is read back from disk, and pin.ts's own header says it must
  // be treated with the same suspicion as any other externally-supplied
  // document. Until 2026-08-27 `path` was checked for `typeof === 'string' &&
  // length > 0` and nothing else, so bundle-hash.ts and pin.ts disagreed about
  // what a pinned path is -- one rejecting traversal segments, NUL bytes and
  // non-canonical spellings, the other accepting all of them. The record is
  // also the map the code cache is laid out from (ADR-0009), so the more
  // permissive of the two decides what actually gets written to disk.
  it('an asset path that is not a valid canonical path', () => {
    for (const path of [
      '../../../../etc/passwd',
      '/../escape.js',
      '/a\u0000b.js',
      'relative.js',
      'C:\\Windows\\System32\\x.dll',
      '/a b.js', // not canonical: real form is /a%20b.js
      '/%zz.js', // undecodable escape
      `/${'a'.repeat(2000)}.js` // over the path length cap
    ]) {
      // The manifest leaf is present so the ONLY reason to reject is `path`.
      // Without it this test passed vacuously once parseAssets started
      // requiring a manifest leaf -- caught by mutation M6, which survived
      // reverting this very check.
      expect(
        parsePinRecord({ ...validRaw(), assets: [MANIFEST_LEAF, { path, leaf: OTHER_HASH }] }),
        `should refuse ${JSON.stringify(path)}`
      ).toBeNull()
    }
  })

  it('duplicate asset paths', () => {
    expect(
      parsePinRecord({
        ...validRaw(),
        assets: [
          MANIFEST_LEAF,
          { path: '/a.js', leaf: OTHER_HASH },
          { path: '/a.js', leaf: VALID_HASH }
        ]
      })
    ).toBeNull()
  })

  // parsePinRecord must refuse every record bundleTree() could not have
  // produced, or the two hold different lines and the more permissive one --
  // the one reading untrusted bytes off disk -- decides what the cache
  // reconstructs. Each of these was accepted before 2026-08-27.
  it('a record bundleTree() could not have produced', () => {
    const raw = validRaw()
    // No leaf at the reserved manifest path.
    expect(parsePinRecord({ ...raw, assets: [{ path: '/index.html', leaf: OTHER_HASH }] })).toBeNull()
    // An empty asset set -- fail-closed either way, but fromBundleTree throws
    // on it and these two must agree.
    expect(parsePinRecord({ ...raw, assets: [] })).toBeNull()
    // Paths that collide under the folding rule bundleTree applies.
    expect(
      parsePinRecord({
        ...raw,
        assets: [
          { path: '/.well-known/orivon.json', leaf: OTHER_HASH },
          { path: '/App.js', leaf: OTHER_HASH },
          { path: '/app.js', leaf: OTHER_HASH }
        ]
      })
    ).toBeNull()
  })

  it('more pinned assets than a bundle may contain', () => {
    const assets = [{ path: '/.well-known/orivon.json', leaf: OTHER_HASH }]
    for (let i = 0; i <= MAX_BUNDLE_ENTRIES; i += 1) assets.push({ path: `/f${i}.js`, leaf: OTHER_HASH })
    expect(parsePinRecord({ ...validRaw(), assets })).toBeNull()
  })

  it('pinnedAt that is not a finite number', () => {
    expect(parsePinRecord({ ...validRaw(), pinnedAt: 'yesterday' })).toBeNull()
    expect(parsePinRecord({ ...validRaw(), pinnedAt: Number.NaN })).toBeNull()
    expect(parsePinRecord({ ...validRaw(), pinnedAt: Number.POSITIVE_INFINITY })).toBeNull()
  })

  // The concrete attack Object.hasOwn exists to stop: a __proto__ key must
  // not resolve through the prototype chain to something that looks valid.
  it('a prototype-polluting origin does not resolve through the chain', () => {
    const raw = JSON.parse('{"__proto__":{"origin":"https://evil.example"}}') as Record<string, unknown>
    const merged = { ...validRaw(), ...raw }
    delete merged.origin
    expect(parsePinRecord(merged)).toBeNull()
  })

  it('a non-array is refused rather than throwing on .some/.map', () => {
    expect(() => parsePinRecord({ ...validRaw(), assets: 5 })).not.toThrow()
  })
})

describe('isPinnedPath: fail-closed membership, exact match only', () => {
  const pin: PinRecord = {
    schema: 1,
    origin: 'https://app.example.com',
    bundleHash: VALID_HASH,
    assets: [
      { path: '/.well-known/orivon.json', leaf: OTHER_HASH },
      { path: '/App.js', leaf: OTHER_HASH },
      { path: '/a%2Fb.js', leaf: OTHER_HASH }
    ],
    version: '0.1.0',
    pinnedAt: 0
  }

  it('a pinned path is allowed', () => {
    expect(isPinnedPath(pin, '/App.js')).toBe(true)
  })

  it('an unrelated path is denied', () => {
    expect(isPinnedPath(pin, '/not-pinned.js')).toBe(false)
  })

  it('a path differing only by case is denied', () => {
    expect(isPinnedPath(pin, '/app.js')).toBe(false)
  })

  it('a path differing only by a trailing slash is denied', () => {
    expect(isPinnedPath(pin, '/App.js/')).toBe(false)
  })

  it('a path differing only by percent-encoding is denied', () => {
    // pinned form is '/a%2Fb.js' (encoded); the decoded form must not match.
    expect(isPinnedPath(pin, '/a/b.js')).toBe(false)
  })

  it('the empty path is denied', () => {
    expect(isPinnedPath(pin, '')).toBe(false)
  })

  it('a pin with no assets denies everything', () => {
    expect(isPinnedPath({ ...pin, assets: [] }, '/App.js')).toBe(false)
  })
})

describe('fromBundleTree: rejects a record that could not have come from bundleTree()', () => {
  it('an empty origin', () => {
    expect(() => fromBundleTree('', VALID_HASH, [MANIFEST_LEAF, { path: '/a', leaf: OTHER_HASH }], '0.1.0', 0)).toThrow()
  })

  it('a non-canonical origin', () => {
    expect(() =>
      fromBundleTree('https://x.example/path', VALID_HASH, [MANIFEST_LEAF, { path: '/a', leaf: OTHER_HASH }], '0.1.0', 0)
    ).toThrow()
  })

  it('a malformed bundle hash', () => {
    expect(() => fromBundleTree('https://x.example', 'nope', [MANIFEST_LEAF, { path: '/a', leaf: OTHER_HASH }], '0.1.0', 0)).toThrow()
  })

  it('zero assets', () => {
    expect(() => fromBundleTree('https://x.example', VALID_HASH, [], '0.1.0', 0)).toThrow()
  })

  it('an empty version', () => {
    expect(() => fromBundleTree('https://x.example', VALID_HASH, [MANIFEST_LEAF, { path: '/a', leaf: OTHER_HASH }], '', 0)).toThrow()
  })

  it('a non-finite pinnedAt', () => {
    expect(() =>
      fromBundleTree('https://x.example', VALID_HASH, [MANIFEST_LEAF, { path: '/a', leaf: OTHER_HASH }], '0.1.0', Number.NaN)
    ).toThrow()
  })

  // The constructor is exported, so it is reachable with an asset list that
  // did not come from bundleTree(). It must hold the same line parsePinRecord
  // does, or the two ways of building a record disagree.
  it('an asset path bundleTree() could not have produced', () => {
    expect(() =>
      fromBundleTree('https://x.example', VALID_HASH, [MANIFEST_LEAF, { path: '/../escape.js', leaf: OTHER_HASH }], '0.1.0', 0)
    ).toThrow()
  })

  it('a malformed leaf digest', () => {
    expect(() =>
      fromBundleTree('https://x.example', VALID_HASH, [MANIFEST_LEAF, { path: '/a', leaf: 'not-a-digest' }], '0.1.0', 0)
    ).toThrow()
  })

  it('duplicate asset paths', () => {
    expect(() =>
      fromBundleTree(
        'https://x.example',
        VALID_HASH,
        [
          MANIFEST_LEAF,
          { path: '/a', leaf: OTHER_HASH },
          { path: '/a', leaf: VALID_HASH }
        ],
        '0.1.0',
        0
      )
    ).toThrow()
  })

  // `readonly` is a compile-time claim, not a runtime one. Validating the
  // caller's array and then storing it BY REFERENCE means every check above
  // can be undone after the record exists -- and the record is T21's
  // allowlist. Found by adversarial review of the first round of these fixes.
  it('copies the asset list rather than aliasing the caller-s array', () => {
    const assets = [MANIFEST_LEAF, { path: '/a.js', leaf: OTHER_HASH }]
    const record = fromBundleTree('https://x.example', VALID_HASH, assets, '0.1.0', 1)
    assets.push({ path: '/../evil.js', leaf: 'not-even-a-digest' })
    expect(record.assets).toHaveLength(2)
    expect(isPinnedPath(record, '/../evil.js')).toBe(false)
  })

  it('accepts a well-formed set and round-trips through parsePinRecord', () => {
    const built = fromBundleTree(
      'https://x.example',
      VALID_HASH,
      [MANIFEST_LEAF, { path: '/a', leaf: OTHER_HASH }],
      '0.1.0',
      1_700_000_000_000
    )
    expect(parsePinRecord(built)).toEqual(built)
  })
})
