import { describe, expect, it } from 'vitest'
import { parseManifest, type ManifestResult } from './manifest.js'

// The input is adversarial by construction (manifest.ts's own header): any
// origin can serve this JSON, and every field is self-asserted. So this
// suite is organised around REJECTION, not the happy path -- each table row
// names the exact trap a coercing validator would fall into.
//
// MUTATION-TESTED by hand against four deliberately-wrong edits to
// manifest.ts (no mutation-testing tool is a dependency here, per CLAUDE.md
// Rule 8 -- pure-JS only), each the specific trap this task's brief named,
// run and reverted:
//
//   1. `pattern === '*' || parsePortRange(...)` accepting "*" for
//      tcp.listen -> caught by 'rejects "*" for tcp.listen' below.
//   2. `range.lo < MIN_UNPRIVILEGED_PORT` weakened to `< 1` (i.e. removed)
//      -> caught by 'rejects a privileged port (below 1024)' below.
//   3. `orivonApiVersion !== 0` changed to `Number(orivonApiVersion) !== 0`,
//      coercing the string "0" into the number 0 -> caught by
//      'rejects the string "0" (coercion trap)' below.
//   4. `compareVersions(version, version) === null` changed to `false`
//      (i.e. the orderability check deleted) -> caught by 'rejects a
//      version that cannot be ordered' below.
//
// All four failed loudly when tried. A passing suite proves nothing until it
// has been watched to fail (docs/development/pr-blueprint.md).

// The capability-api.md SSManifest example, verbatim -- the flagship's own
// declaration, and the shape every other test in this file starts from.
function fullManifest (): Record<string, unknown> {
  return {
    orivonApiVersion: 0,
    id: 'app.orivon.torrent',
    name: 'Orivon Torrent',
    version: '0.1.0',
    entry: 'index.html',
    capabilities: {
      net: {
        tcp: { connect: ['*:*'], listen: ['6881-6889'] },
        udp: { bind: ['6881-6889'], send: ['*:*'] }
      },
      fs: { quotaBytes: 53687091200 },
      id: { curves: ['secp256k1'] },
      protocols: ['magnet']
    }
  }
}

/** Required fields only, `capabilities: {}` -- the smallest manifest that must be accepted. */
function minimal (overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    orivonApiVersion: 0,
    id: 'app.orivon.test',
    name: 'Test App',
    version: '1.0.0',
    entry: 'index.html',
    capabilities: {},
    ...overrides
  }
}

function withCapabilities (capabilities: unknown): Record<string, unknown> {
  return minimal({ capabilities })
}

function reason (result: ManifestResult): string {
  if (result.ok) throw new Error('expected a rejection, got ok:true')
  return result.reason
}

describe('a fully valid manifest', () => {
  it('accepts the capability-api.md example verbatim', () => {
    const result = parseManifest(fullManifest())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest).toEqual({
      orivonApiVersion: 0,
      id: 'app.orivon.torrent',
      name: 'Orivon Torrent',
      version: '0.1.0',
      entry: 'index.html',
      capabilities: {
        net: {
          tcp: { connect: ['*:*'], listen: ['6881-6889'] },
          udp: { bind: ['6881-6889'], send: ['*:*'] }
        },
        fs: { quotaBytes: 53687091200 },
        id: { curves: ['secp256k1'] },
        protocols: ['magnet']
      }
    })
  })

  it('accepts the smallest legal manifest -- capabilities: {}', () => {
    expect(parseManifest(minimal()).ok).toBe(true)
  })

  it('accepts a JSON string, not only an already-parsed value', () => {
    const result = parseManifest(JSON.stringify(fullManifest()))
    expect(result.ok).toBe(true)
  })
})

describe('orivonApiVersion', () => {
  it('accepts exactly 0', () => {
    expect(parseManifest(minimal({ orivonApiVersion: 0 })).ok).toBe(true)
  })

  it('rejects 1', () => {
    expect(reason(parseManifest(minimal({ orivonApiVersion: 1 })))).toMatch(/orivonApiVersion/)
  })

  it('rejects the string "0" (coercion trap)', () => {
    const result = parseManifest(minimal({ orivonApiVersion: '0' }))
    expect(result.ok).toBe(false)
    expect(reason(result)).toMatch(/orivonApiVersion must be exactly 0/)
  })

  it('rejects a missing orivonApiVersion', () => {
    const raw = minimal()
    delete raw.orivonApiVersion
    expect(reason(parseManifest(raw))).toMatch(/orivonApiVersion/)
  })

  it('rejects null', () => {
    expect(reason(parseManifest(minimal({ orivonApiVersion: null })))).toMatch(/orivonApiVersion/)
  })
})

describe('tcp.listen / udp.bind -- port ranges', () => {
  const netWith = (listen: unknown): Record<string, unknown> =>
    withCapabilities({ net: { tcp: { listen } } })

  it('rejects "*" for tcp.listen', () => {
    expect(reason(parseManifest(netWith(['*'])))).toMatch(/declared port range is required/)
  })

  it('rejects a privileged port (below 1024)', () => {
    expect(reason(parseManifest(netWith(['80'])))).toMatch(/privileged ports below 1024/)
  })

  it('rejects the top of the privileged range, 1023', () => {
    expect(reason(parseManifest(netWith(['1023'])))).toMatch(/privileged/)
  })

  it('accepts the first unprivileged port, 1024', () => {
    expect(parseManifest(netWith(['1024'])).ok).toBe(true)
  })

  it('rejects a range that starts privileged even if it ends high', () => {
    expect(reason(parseManifest(netWith(['1000-2000'])))).toMatch(/privileged/)
  })

  it('accepts a normal range', () => {
    expect(parseManifest(netWith(['6881-6889'])).ok).toBe(true)
  })

  it.each([
    ['non-numeric', 'abc'],
    ['empty', ''],
    ['trailing dash', '6881-'],
    ['leading dash', '-6889'],
    ['leading zero', '06881'],
    ['above MAX_PORT', '70000'],
    ['inverted range', '6889-6881'],
    ['a host:port pattern, not a bare range', 'example.com:6881']
  ])('rejects a malformed range (%s: %s)', (_label, spec) => {
    expect(reason(parseManifest(netWith([spec])))).toMatch(/not a valid port|privileged|not a valid host/)
  })

  it('rejects an empty array -- omit the field instead', () => {
    expect(reason(parseManifest(netWith([])))).toMatch(/must not be empty/)
  })

  it('rejects more than 256 entries', () => {
    const many = Array.from({ length: 257 }, (_, i) => String(1024 + i))
    expect(reason(parseManifest(netWith(many)))).toMatch(/more than the 256 allowed/)
  })

  it('rejects a non-array value', () => {
    expect(reason(parseManifest(netWith('6881-6889')))).toMatch(/must be an array/)
  })

  it('rejects a non-string element', () => {
    expect(reason(parseManifest(netWith([6881])))).toMatch(/must be a string/)
  })

  it('applies the identical rule to udp.bind', () => {
    const raw = withCapabilities({ net: { udp: { bind: ['*'] } } })
    expect(reason(parseManifest(raw))).toMatch(/declared port range is required/)

    const privileged = withCapabilities({ net: { udp: { bind: ['22'] } } })
    expect(reason(parseManifest(privileged))).toMatch(/privileged/)

    const ok = withCapabilities({ net: { udp: { bind: ['6881-6889'] } } })
    expect(parseManifest(ok).ok).toBe(true)
  })
})

describe('tcp.connect / udp.send -- host:port patterns', () => {
  const netWith = (connect: unknown): Record<string, unknown> =>
    withCapabilities({ net: { tcp: { connect } } })

  it('accepts "*:*" -- the genuine P2P declaration', () => {
    expect(parseManifest(netWith(['*:*'])).ok).toBe(true)
  })

  it('accepts a concrete host:port', () => {
    expect(parseManifest(netWith(['api.example.com:443'])).ok).toBe(true)
  })

  it('accepts a bracketed IPv6 literal', () => {
    expect(parseManifest(netWith(['[::1]:443'])).ok).toBe(true)
  })

  it('accepts a port range on the port half', () => {
    expect(parseManifest(netWith(['api.example.com:6881-6889'])).ok).toBe(true)
  })

  it('does NOT deny a privileged port -- connect is not listen', () => {
    expect(parseManifest(netWith(['api.example.com:443'])).ok).toBe(true)
    expect(parseManifest(netWith(['api.example.com:1'])).ok).toBe(true)
  })

  it('rejects a bare port range -- connect always needs a host', () => {
    expect(reason(parseManifest(netWith(['6881-6889'])))).toMatch(/not a valid host:port/)
  })

  it('rejects unbracketed IPv6', () => {
    expect(reason(parseManifest(netWith(['::1:443'])))).toMatch(/not a valid host:port/)
  })

  it('rejects a non-numeric port', () => {
    expect(reason(parseManifest(netWith(['api.example.com:abc'])))).toMatch(/malformed port/)
  })

  it('rejects an out-of-range port', () => {
    expect(reason(parseManifest(netWith(['api.example.com:70000'])))).toMatch(/malformed port/)
  })

  it('applies the identical grammar to udp.send', () => {
    const raw = withCapabilities({ net: { udp: { send: ['*:*'] } } })
    expect(parseManifest(raw).ok).toBe(true)

    const bad = withCapabilities({ net: { udp: { send: ['6881-6889'] } } })
    expect(reason(parseManifest(bad))).toMatch(/not a valid host:port/)
  })
})

describe('version -- must be orderable semver', () => {
  it.each([
    '0.1.0',
    '1.2.3',
    '1.2.3-beta.1',
    '1.2.3+build.7', // build metadata stripped, not part of ordering
    '1.2' // trailing components default to zero; still orderable
  ])('accepts %s', (version) => {
    expect(parseManifest(minimal({ version })).ok).toBe(true)
  })

  it.each([
    ['a bare "v" prefix', 'v1.2.3'],
    ['a non-numeric release component', '1.x.0'],
    ['an empty prerelease identifier', '1.2.3-'],
    ['not a version at all', 'not-a-version']
  ])('rejects a version that cannot be ordered (%s: %s)', (_label, version) => {
    const result = parseManifest(minimal({ version }))
    expect(result.ok).toBe(false)
    expect(reason(result)).toMatch(/does not parse as orderable semver/)
  })

  it('rejects an empty string', () => {
    expect(reason(parseManifest(minimal({ version: '' })))).toMatch(/version must be/)
  })

  it('rejects a non-string version', () => {
    expect(reason(parseManifest(minimal({ version: 1.2 })))).toMatch(/version must be a string/)
  })
})

describe('entry', () => {
  it('accepts a plain relative filename', () => {
    expect(parseManifest(minimal({ entry: 'index.html' })).ok).toBe(true)
  })

  it('accepts a nested relative path', () => {
    expect(parseManifest(minimal({ entry: 'app/index.html' })).ok).toBe(true)
  })

  it('rejects a leading slash', () => {
    expect(reason(parseManifest(minimal({ entry: '/index.html' })))).toMatch(/without a leading slash/)
  })

  it('rejects an absolute URL -- must not smuggle a scheme past the app root', () => {
    expect(reason(parseManifest(minimal({ entry: 'https://evil.example/index.html' }))))
      .toMatch(/must not be an absolute URL/)
  })

  it('rejects a javascript: scheme', () => {
    expect(reason(parseManifest(minimal({ entry: 'javascript:alert(1)' }))))
      .toMatch(/must not be an absolute URL/)
  })

  it('rejects path traversal', () => {
    expect(reason(parseManifest(minimal({ entry: '../../../etc/passwd' })))).toMatch(/not a safe relative path/)
  })

  it('rejects an embedded NUL byte', () => {
    expect(reason(parseManifest(minimal({ entry: 'index.html\u0000.txt' })))).toMatch(/not a safe relative path/)
  })

  it('rejects a missing entry', () => {
    const raw = minimal()
    delete raw.entry
    expect(reason(parseManifest(raw))).toMatch(/entry is required/)
  })
})

describe('id and name -- self-asserted, still bounded', () => {
  it('rejects an empty id', () => {
    expect(reason(parseManifest(minimal({ id: '' })))).toMatch(/id must be/)
  })

  it('rejects an id over the length bound', () => {
    expect(reason(parseManifest(minimal({ id: 'a'.repeat(256) })))).toMatch(/id must be/)
  })

  it('rejects control characters in name -- it is rendered in the grant prompt', () => {
    expect(reason(parseManifest(minimal({ name: 'Evil\u0000App' })))).toMatch(/control characters/)
  })

  it('rejects a non-string name', () => {
    expect(reason(parseManifest(minimal({ name: 42 })))).toMatch(/name must be a string/)
  })

  it('accepts a name at the boundary of the length bound', () => {
    expect(parseManifest(minimal({ name: 'a'.repeat(200) })).ok).toBe(true)
  })
})

describe('fs.quotaBytes', () => {
  const fsWith = (quotaBytes: unknown): Record<string, unknown> => withCapabilities({ fs: { quotaBytes } })

  it('accepts a positive integer', () => {
    expect(parseManifest(fsWith(53687091200)).ok).toBe(true)
  })

  it('rejects zero', () => {
    expect(reason(parseManifest(fsWith(0)))).toMatch(/must be positive/)
  })

  it('rejects a negative number', () => {
    expect(reason(parseManifest(fsWith(-1)))).toMatch(/must be positive/)
  })

  it('rejects a non-integer', () => {
    expect(reason(parseManifest(fsWith(1.5)))).toMatch(/must be an integer/)
  })

  it('rejects a number beyond Number.MAX_SAFE_INTEGER', () => {
    expect(reason(parseManifest(fsWith(Number.MAX_SAFE_INTEGER * 4)))).toMatch(/MAX_SAFE_INTEGER|must be an integer/)
  })

  it('rejects a numeric string (coercion trap)', () => {
    expect(reason(parseManifest(fsWith('53687091200')))).toMatch(/must be a finite number/)
  })

  it('rejects Infinity', () => {
    expect(reason(parseManifest(fsWith(Number.POSITIVE_INFINITY)))).toMatch(/must be a finite number/)
  })

  it('omitting quotaBytes entirely is legal', () => {
    expect(parseManifest(withCapabilities({ fs: {} })).ok).toBe(true)
  })
})

describe('protocols and id.curves', () => {
  it('accepts a well-formed scheme list', () => {
    expect(parseManifest(withCapabilities({ protocols: ['magnet'] })).ok).toBe(true)
  })

  it('rejects an uppercase scheme -- one canonical spelling, not two', () => {
    expect(reason(parseManifest(withCapabilities({ protocols: ['MAGNET'] })))).toMatch(/not a valid URI scheme/)
  })

  it('rejects a scheme starting with a digit', () => {
    expect(reason(parseManifest(withCapabilities({ protocols: ['1magnet'] })))).toMatch(/not a valid URI scheme/)
  })

  it('accepts a free-form curve name -- curve is deliberately not an enum', () => {
    expect(parseManifest(withCapabilities({ id: { curves: ['secp256k1'] } })).ok).toBe(true)
    expect(parseManifest(withCapabilities({ id: { curves: ['some-future-curve'] } })).ok).toBe(true)
  })

  it('rejects a curve name with control characters', () => {
    expect(reason(parseManifest(withCapabilities({ id: { curves: ['P-256\n'] } })))).toMatch(/control characters/)
  })
})

describe('unknown fields, wrong types and prototype pollution', () => {
  it('rejects an unrecognised top-level field', () => {
    expect(reason(parseManifest(minimal({ signature: 'abc' })))).toMatch(/unrecognised field: "signature"/)
  })

  it('rejects an unrecognised field inside capabilities', () => {
    expect(reason(parseManifest(withCapabilities({ shell: true })))).toMatch(/unrecognised field: "shell"/)
  })

  it('rejects an unrecognised field inside net.tcp', () => {
    const raw = withCapabilities({ net: { tcp: { connect: ['*:*'], backdoor: true } } })
    expect(reason(parseManifest(raw))).toMatch(/unrecognised field: "backdoor"/)
  })

  it('rejects a "__proto__" own key as an unrecognised field, rather than polluting anything', () => {
    // JSON.parse gives "__proto__" as an ordinary own property, never the
    // real prototype slot -- this asserts it is refused as an unknown field
    // like any other, and that the parse does not throw or corrupt anything.
    const raw = JSON.parse('{"__proto__": {"polluted": true}, "orivonApiVersion": 0}') as Record<string, unknown>
    const result = parseManifest({ ...minimal(), ...raw })
    expect(result.ok).toBe(false)
    expect(reason(result)).toMatch(/unrecognised field: "__proto__"/)
    // eslint-disable-next-line no-prototype-builtins
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('rejects a "constructor" own key the same way', () => {
    const raw = minimal({ constructor: { evil: true } })
    expect(reason(parseManifest(raw))).toMatch(/unrecognised field: "constructor"/)
  })

  it('rejects the manifest itself being an array', () => {
    expect(reason(parseManifest([1, 2, 3]))).toMatch(/manifest must be a JSON object/)
  })

  it('rejects the manifest itself being null', () => {
    expect(reason(parseManifest(null))).toMatch(/manifest must be a JSON object/)
  })

  it('rejects the manifest itself being a primitive', () => {
    expect(reason(parseManifest('just a string'))).toMatch(/not valid JSON|manifest must be a JSON object/)
  })

  it('rejects capabilities being an array instead of an object', () => {
    expect(reason(parseManifest(minimal({ capabilities: [] })))).toMatch(/capabilities must be an object/)
  })

  it('never coerces a boolean field to a string', () => {
    expect(reason(parseManifest(minimal({ id: true })))).toMatch(/id must be a string/)
  })
})

describe('absurd sizes and deeply nested junk', () => {
  it('rejects raw manifest text over the byte bound, before JSON.parse ever runs', () => {
    const huge = JSON.stringify(minimal({ name: 'a'.repeat(200_000) }))
    const result = parseManifest(huge)
    expect(result.ok).toBe(false)
    expect(reason(result)).toMatch(/exceeds 65536 bytes/)
  })

  it('rejects deeply nested junk assigned to a string field without recursing into it', () => {
    let nested: unknown = 'bottom'
    for (let i = 0; i < 10_000; i += 1) nested = [nested]
    const result = parseManifest(minimal({ name: nested }))
    expect(result.ok).toBe(false)
    expect(reason(result)).toMatch(/name must be a string/)
  })

  it('rejects deeply nested junk as the whole input, on its first unrecognised key', () => {
    let nested: Record<string, unknown> = { bottom: true }
    for (let i = 0; i < 10_000; i += 1) nested = { wrapper: nested }
    const result = parseManifest(nested)
    expect(result.ok).toBe(false)
    expect(reason(result)).toMatch(/unrecognised field: "wrapper"/)
  })

  it('rejects more than 32 protocol schemes', () => {
    const many = Array.from({ length: 33 }, () => 'magnet')
    expect(reason(parseManifest(withCapabilities({ protocols: many })))).toMatch(/more than the 32 allowed/)
  })

  it('rejects more than 8 curves', () => {
    const many = Array.from({ length: 9 }, (_, i) => `curve-${i}`)
    expect(reason(parseManifest(withCapabilities({ id: { curves: many } })))).toMatch(/more than the 8 allowed/)
  })

  it('rejects empty manifest text', () => {
    expect(reason(parseManifest(''))).toMatch(/empty/)
  })

  it('rejects text that is not JSON at all', () => {
    expect(reason(parseManifest('{not json'))).toMatch(/not valid JSON/)
  })
})
