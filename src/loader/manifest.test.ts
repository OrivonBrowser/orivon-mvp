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
    assets: ['style.css', 'app.js'],
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
      assets: ['style.css', 'app.js'],
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

  it('an app with no assets beyond entry omits the field entirely, not an empty array', () => {
    const result = parseManifest(minimal())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest.assets).toBeUndefined()
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

  it('rejects NaN, naming it by its real value rather than "null" (finding 5)', () => {
    expect(reason(parseManifest(minimal({ orivonApiVersion: Number.NaN })))).toMatch(/got NaN/)
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

  // Finding 2 -- validateConnectPattern only checked the port half; the host
  // half was never validated. Every row here was ACCEPTED before the fix,
  // measured during triage. Each is either a dead capability (matches
  // nothing at connect time, per connect-patterns.ts's own hostMatches) or a
  // UI-truncation spoof (a padded host rendered verbatim into the grant
  // prompt).
  it('rejects a sub-glob host -- matches nothing at connect time', () => {
    expect(reason(parseManifest(netWith(['*.example.com:443'])))).toMatch(/sub-glob/)
  })

  it('rejects a bare "*" host paired with a concrete port -- only "*:*" is documented', () => {
    expect(reason(parseManifest(netWith(['*:443'])))).toMatch(/\*:\*/)
  })

  it('rejects a decimal-encoded IPv4 literal -- non-canonical, matches nothing', () => {
    expect(reason(parseManifest(netWith(['2130706433:443'])))).toMatch(/not written canonically|non-canonical|canonical/)
  })

  it('rejects a hex-encoded IPv4 literal', () => {
    expect(reason(parseManifest(netWith(['0x7f000001:443'])))).toMatch(/canonical/)
  })

  it('rejects an octal-encoded IPv4 literal', () => {
    expect(reason(parseManifest(netWith(['017700000001:443'])))).toMatch(/canonical/)
  })

  it('rejects an embedded space in the host', () => {
    expect(reason(parseManifest(netWith(['exam ple.com:443'])))).toMatch(/canonical|whitespace/)
  })

  it('rejects an empty label (double dot)', () => {
    expect(reason(parseManifest(netWith(['nonexistent..host:443'])))).toMatch(/empty label/)
  })

  it('rejects 60 trailing spaces on an otherwise-valid host -- a UI-truncation spoof', () => {
    const padded = 'example.com' + ' '.repeat(60) + ':443'
    expect(reason(parseManifest(netWith([padded])))).toMatch(/canonical|whitespace/)
  })

  it('rejects 60 leading spaces on an otherwise-valid host', () => {
    const padded = ' '.repeat(60) + 'example.com:443'
    expect(reason(parseManifest(netWith([padded])))).toMatch(/canonical|whitespace/)
  })

  it('still accepts an ordinary concrete host after the host-half fix', () => {
    expect(parseManifest(netWith(['api.example.com:443'])).ok).toBe(true)
  })

  it('still accepts a bracketed canonical IPv6 literal after the host-half fix', () => {
    expect(parseManifest(netWith(['[::1]:443'])).ok).toBe(true)
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

  // Finding 4 -- version got no CONTROL_CHARS/whitespace check at all, only
  // compareVersions(version, version) === null. update.ts's own parseVersion
  // trims before parsing, so '1.2.3\n' and '1.2.3' compare EQUAL despite
  // being different strings -- exactly the "two spellings of one thing"
  // ambiguity this file refuses everywhere else. Build metadata (after '+')
  // is never examined by compareVersions, so it is unvalidated free text
  // that reaches the grant prompt.
  it('rejects a trailing newline -- two spellings that compare equal must not both be accepted', () => {
    // '\n' is itself a C0 control character, so this trips the unsafe-char
    // check before the dedicated whitespace check ever runs -- both are
    // correct rejections of the same input, and either message is fine.
    expect(reason(parseManifest(minimal({ version: '1.2.3\n' })))).toMatch(/whitespace|unsafe/)
  })

  it('rejects leading whitespace', () => {
    expect(reason(parseManifest(minimal({ version: ' 1.2.3' })))).toMatch(/whitespace/)
  })

  it('rejects a bidi override hidden in the build-metadata half', () => {
    expect(reason(parseManifest(minimal({ version: '1.2.3+\u202ejunk' })))).toMatch(/unsafe/)
  })

  it('rejects a NUL byte in version', () => {
    expect(reason(parseManifest(minimal({ version: '1.2.3' + String.fromCharCode(0) })))).toMatch(/unsafe/)
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

  // Finding 3 -- validateEntry fed RAW text into a checker that expects
  // already-percent-encoded URL.pathname output, so ordinary filenames with
  // a space or an accented character were rejected with a message
  // ("not a safe relative path") that told the developer their filename was
  // dangerous rather than that it needed percent-encoding.
  it('accepts a plain filename with a space -- was wrongly rejected before the fix', () => {
    expect(parseManifest(minimal({ entry: 'my app.html' })).ok).toBe(true)
  })

  it('accepts an accented filename -- was wrongly rejected before the fix', () => {
    const result = parseManifest(minimal({ entry: 'app/café.html' }))
    expect(result.ok).toBe(true)
  })

  it('still rejects deep path traversal after the encode-first fix', () => {
    expect(reason(parseManifest(minimal({ entry: '../../../etc/passwd' })))).toMatch(/not a safe relative path/)
  })

  it('still rejects single-level path traversal', () => {
    expect(reason(parseManifest(minimal({ entry: '../evil.html' })))).toMatch(/not a safe relative path/)
  })

  it('still rejects an encoded traversal attempt (%2F)', () => {
    expect(reason(parseManifest(minimal({ entry: '..%2Fevil.html' })))).toMatch(/not a safe relative path/)
  })

  it('still rejects a Windows-reserved device name', () => {
    expect(reason(parseManifest(minimal({ entry: 'CON.html' })))).toMatch(/not a safe relative path/)
  })

  it('still rejects an embedded NUL byte after the encode-first fix', () => {
    expect(reason(parseManifest(minimal({ entry: 'index.html' + String.fromCharCode(0) + '.txt' }))))
      .toMatch(/not a safe relative path/)
  })
})

// ADR-0011: the app's own declared file list, alongside entry. Reuses
// entry's own path-safety checks (Rule 3) -- these are not a second grammar.
describe('assets', () => {
  it('accepts a list of plain relative filenames', () => {
    expect(parseManifest(minimal({ assets: ['style.css', 'app.js'] })).ok).toBe(true)
  })

  it('accepts a nested relative path', () => {
    expect(parseManifest(minimal({ assets: ['css/style.css'] })).ok).toBe(true)
  })

  it('omitting the field is fine -- an app can be entry alone', () => {
    expect(parseManifest(minimal()).ok).toBe(true)
  })

  it('rejects an empty array -- omit the field instead, same rule every optional list uses', () => {
    expect(reason(parseManifest(minimal({ assets: [] })))).toMatch(/must not be empty when present/)
  })

  it('rejects a non-array value', () => {
    expect(reason(parseManifest(minimal({ assets: 'style.css' })))).toMatch(/assets must be an array/)
  })

  it('rejects a non-string element', () => {
    expect(reason(parseManifest(minimal({ assets: [42] })))).toMatch(/assets\[0\] must be a string/)
  })

  it('rejects path traversal in an asset path, the same way entry rejects it', () => {
    expect(reason(parseManifest(minimal({ assets: ['../../../etc/passwd'] })))).toMatch(/not a safe relative path/)
  })

  it('rejects an absolute URL as an asset path', () => {
    expect(reason(parseManifest(minimal({ assets: ['https://evil.example/x.js'] }))))
      .toMatch(/must not be an absolute URL/)
  })

  // Belongs to this file rather than fetch-bundle.test.ts because
  // parseManifest is what rejects it: `new URL()` does not recognise this
  // string as an absolute reference (isAbsoluteUrl returns false), so it
  // falls through to the relative-path branch below, and the check that
  // catches it is this file's own encoding + canonical-path one.
  it('rejects a malformed URL-shaped asset path, even though it does not parse as absolute', () => {
    expect(reason(parseManifest(minimal({ assets: ['http://[not-valid-ipv6/x.js'] }))))
      .toMatch(/not a safe relative path/)
  })

  it('rejects a leading slash', () => {
    expect(reason(parseManifest(minimal({ assets: ['/app.js'] })))).toMatch(/without a leading slash/)
  })

  it('rejects an asset path identical to entry -- one file, one name for it', () => {
    expect(reason(parseManifest(minimal({ entry: 'index.html', assets: ['index.html'] }))))
      .toMatch(/assets\[0\] duplicates entry/)
  })

  it('rejects two identical entries within assets', () => {
    expect(reason(parseManifest(minimal({ assets: ['app.js', 'app.js'] }))))
      .toMatch(/assets\[1\] duplicates assets\[0\]/)
  })

  // collisionKey (canonical-path.ts), not exact string match -- the same
  // idiom bundle-hash.ts's bundleTree() and pin.ts already use for this
  // exact class of check (Rule 3). Two spellings that name the same file
  // under percent-decoding/case/Unicode folding must not both validate as
  // distinct entries, the same stance this file already takes on every
  // other field.
  it('rejects two assets that differ only by case', () => {
    expect(reason(parseManifest(minimal({ assets: ['app.js', 'APP.JS'] }))))
      .toMatch(/assets\[1\] duplicates assets\[0\]/)
  })

  it('rejects an asset that is a percent-encoded duplicate of entry', () => {
    expect(reason(parseManifest(minimal({ entry: 'index.html', assets: ['%69ndex.html'] }))))
      .toMatch(/assets\[0\] duplicates entry/)
  })

  it('rejects more entries than the bundle could ever hold', () => {
    const tooMany = Array.from({ length: 4096 }, (_, i) => `f${i}.js`)
    expect(reason(parseManifest(minimal({ assets: tooMany })))).toMatch(/more than the/)
  })

  // Two slots are reserved off MAX_BUNDLE_ENTRIES, not one: `entry` itself is
  // unioned into `assetPaths` by a real caller (ADR-0011's own "the loader
  // fetches the union of the two"), and fetch-bundle.ts's own `+1` in
  // `assetPaths.length + 1 > MAX_BUNDLE_ENTRIES` reserves a further slot for
  // the manifest leaf it always pushes onto `entries` first. So the true cap
  // on `assets.length` is MAX_BUNDLE_ENTRIES - 2, not - 1 -- see MAX_ASSETS's
  // own comment in manifest.ts.
  it('accepts exactly one below the true cap, leaving room for entry and the manifest leaf', () => {
    const atCap = Array.from({ length: 4094 }, (_, i) => `f${i}.js`)
    expect(parseManifest(minimal({ assets: atCap })).ok).toBe(true)
  })

  it('rejects one past the true cap, where fetch-bundle.ts would always reject it downstream', () => {
    const overCap = Array.from({ length: 4095 }, (_, i) => `f${i}.js`)
    expect(reason(parseManifest(minimal({ assets: overCap })))).toMatch(/more than the/)
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
    expect(reason(parseManifest(minimal({ name: 'Evil\u0000App' })))).toMatch(/unsafe/)
  })

  it('rejects a bidi override in name -- the RLO filename-spoof trick (T25)', () => {
    // Renders in a grant prompt as "Safe App exe.jpg" -- the classic RLO spoof.
    expect(reason(parseManifest(minimal({ name: 'Safe App \u202egpj.exe' })))).toMatch(/unsafe/)
  })

  it('rejects a zero-width character in id -- would render identically to another id (T18)', () => {
    expect(reason(parseManifest(minimal({ id: 'app.orivon.\u200btorrent' })))).toMatch(/unsafe/)
  })

  it.each([
    ['RLO override', '\u202e'],
    ['LRO override', '\u202d'],
    ['first strong isolate', '\u2066'],
    ['pop directional isolate', '\u2069'],
    ['zero-width space', '\u200b'],
    ['zero-width joiner', '\u200d'],
    ['BOM / zero-width no-break space', '\ufeff'],
    ['line separator', '\u2028'],
    ['paragraph separator', '\u2029']
  ])('rejects %s in id', (_label, char) => {
    expect(reason(parseManifest(minimal({ id: `app.orivon.${char}test` })))).toMatch(/unsafe/)
  })

  it('rejects a non-string name', () => {
    expect(reason(parseManifest(minimal({ name: 42 })))).toMatch(/name must be a string/)
  })

  it('accepts a name at the boundary of the length bound', () => {
    expect(parseManifest(minimal({ name: 'a'.repeat(200) })).ok).toBe(true)
  })

  // Minor finding 7 -- an all-whitespace id or name was accepted, weakening
  // the claimed-name trust signal the grant prompt depends on.
  it('rejects an all-whitespace name', () => {
    expect(reason(parseManifest(minimal({ name: '   ' })))).toMatch(/non-whitespace character/)
  })

  it('rejects an all-whitespace id', () => {
    expect(reason(parseManifest(minimal({ id: '   ' })))).toMatch(/non-whitespace character/)
  })

  // Minor finding 8 -- an unpaired UTF-16 surrogate in id encodes
  // inconsistently across storage and display, a risk for the T18
  // collision-surfacing requirement. Taken here per pr-29.md's own
  // conditional ("take it if you are already touching the id checks for
  // finding 1") -- finding 1 already reworked this exact validation.
  it('rejects an unpaired high surrogate in id', () => {
    expect(reason(parseManifest(minimal({ id: 'app.\uD800test' })))).toMatch(/surrogate/)
  })

  it('rejects an unpaired low surrogate in id', () => {
    expect(reason(parseManifest(minimal({ id: 'app.\uDC00test' })))).toMatch(/surrogate/)
  })

  it('accepts a properly paired surrogate (real astral character) in id', () => {
    expect(parseManifest(minimal({ id: 'app.😀test' })).ok).toBe(true)
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

  // Finding 5 -- describeValue special-cased number/boolean/null to
  // JSON.stringify(value), but JSON.stringify(NaN) and JSON.stringify(Infinity)
  // both return the STRING "null", so the error message told the developer
  // the value was null when it was NaN or Infinity -- on exactly the field
  // whose rejection reason is "not a finite number".
  it('names NaN by its real value, not "null"', () => {
    expect(reason(parseManifest(fsWith(Number.NaN)))).toMatch(/got NaN/)
  })

  it('names Infinity by its real value, not "null"', () => {
    expect(reason(parseManifest(fsWith(Number.POSITIVE_INFINITY)))).toMatch(/got Infinity/)
  })

  it('names -Infinity by its real value, not "null"', () => {
    expect(reason(parseManifest(fsWith(Number.NEGATIVE_INFINITY)))).toMatch(/got -Infinity/)
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
