import { describe, expect, it } from 'vitest'
import { fromBundleTree, isPinnedPath, parsePinRecord, type PinRecord } from './pin.js'

const VALID_HASH = 'sha256:2ff5baaa794301118be4270755686fd1438501332ab3b1a199af90815ca4c4fd'
const OTHER_HASH = 'sha256:d7cc8d092809e3f091d7f11a7dcccfceba519540a5f5730f80068b371b358e25'

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

  it('an asset entry missing path or leaf, or with a bad leaf shape', () => {
    expect(parsePinRecord({ ...validRaw(), assets: [{ leaf: OTHER_HASH }] })).toBeNull()
    expect(parsePinRecord({ ...validRaw(), assets: [{ path: '/a' }] })).toBeNull()
    expect(parsePinRecord({ ...validRaw(), assets: [{ path: '/a', leaf: 'bad' }] })).toBeNull()
    expect(parsePinRecord({ ...validRaw(), assets: ['/a'] })).toBeNull()
  })

  it('an empty asset path', () => {
    expect(parsePinRecord({ ...validRaw(), assets: [{ path: '', leaf: OTHER_HASH }] })).toBeNull()
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
      expect(
        parsePinRecord({ ...validRaw(), assets: [{ path, leaf: OTHER_HASH }] }),
        `should refuse ${JSON.stringify(path)}`
      ).toBeNull()
    }
  })

  it('duplicate asset paths', () => {
    expect(
      parsePinRecord({
        ...validRaw(),
        assets: [
          { path: '/a.js', leaf: OTHER_HASH },
          { path: '/a.js', leaf: VALID_HASH }
        ]
      })
    ).toBeNull()
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
    expect(() => fromBundleTree('', VALID_HASH, [{ path: '/a', leaf: OTHER_HASH }], '0.1.0', 0)).toThrow()
  })

  it('a malformed bundle hash', () => {
    expect(() => fromBundleTree('https://x.example', 'nope', [{ path: '/a', leaf: OTHER_HASH }], '0.1.0', 0)).toThrow()
  })

  it('zero assets', () => {
    expect(() => fromBundleTree('https://x.example', VALID_HASH, [], '0.1.0', 0)).toThrow()
  })

  it('an empty version', () => {
    expect(() => fromBundleTree('https://x.example', VALID_HASH, [{ path: '/a', leaf: OTHER_HASH }], '', 0)).toThrow()
  })

  it('a non-finite pinnedAt', () => {
    expect(() =>
      fromBundleTree('https://x.example', VALID_HASH, [{ path: '/a', leaf: OTHER_HASH }], '0.1.0', Number.NaN)
    ).toThrow()
  })

  // The constructor is exported, so it is reachable with an asset list that
  // did not come from bundleTree(). It must hold the same line parsePinRecord
  // does, or the two ways of building a record disagree.
  it('an asset path bundleTree() could not have produced', () => {
    expect(() =>
      fromBundleTree('https://x.example', VALID_HASH, [{ path: '/../escape.js', leaf: OTHER_HASH }], '0.1.0', 0)
    ).toThrow()
  })

  it('a malformed leaf digest', () => {
    expect(() =>
      fromBundleTree('https://x.example', VALID_HASH, [{ path: '/a', leaf: 'not-a-digest' }], '0.1.0', 0)
    ).toThrow()
  })

  it('duplicate asset paths', () => {
    expect(() =>
      fromBundleTree(
        'https://x.example',
        VALID_HASH,
        [
          { path: '/a', leaf: OTHER_HASH },
          { path: '/a', leaf: VALID_HASH }
        ],
        '0.1.0',
        0
      )
    ).toThrow()
  })

  it('accepts a well-formed set and round-trips through parsePinRecord', () => {
    const built = fromBundleTree(
      'https://x.example',
      VALID_HASH,
      [{ path: '/a', leaf: OTHER_HASH }],
      '0.1.0',
      1_700_000_000_000
    )
    expect(parsePinRecord(built)).toEqual(built)
  })
})
