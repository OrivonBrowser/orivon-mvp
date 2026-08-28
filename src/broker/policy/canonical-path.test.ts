import { describe, expect, it } from 'vitest'
import { bundleHash, type BundleEntry } from './bundle-hash.js'
import { canonicalAssetPath } from './canonical-path.js'
import { manifestEntry, utf8 } from './bundle-hash.test-helpers.js'

// The path-validation half of the bundle hash's suite (split out of one file
// that exceeded docs/development/code-guidelines.md's 800-line test limit --
// see ./bundle-hash.test.ts for the root/tree-construction half).
//
// Every case here goes through bundleHash with a stub bundle, the same
// discipline ./connect.test.ts uses for checkConnect: a validator can be
// flawless in isolation and the pipeline that is supposed to call it can
// still skip it, so these test the integration point rather than
// isValidCanonicalPath/collisionKey directly.

describe('rejected before hashing', () => {
  it('two paths colliding under case folding', async () => {
    await expect(
      bundleHash([
        manifestEntry(),
        { path: '/App.js', content: utf8('1') },
        { path: '/app.js', content: utf8('2') }
      ])
    ).rejects.toMatchObject({ code: 'invalid' })
  })

  // ---------------------------------------------------------------------
  // THE COLLISION RULE, TESTED IN THE FORM IT ACTUALLY ARRIVES IN.
  //
  // Every case below previously PASSED and should not have. The earlier
  // version of this test fed RAW Unicode strings, which canonicalAssetPath()
  // can never emit -- new URL() percent-encodes non-ASCII before anything here
  // sees it. So the collision key was computed over pure-ASCII percent-escapes,
  // where .normalize('NFC') is a no-op and .toLowerCase() folds nothing that
  // matters, and the rule ADR-0009 records as an OWNER DECISION never fired.
  //
  // Each case is written as canonicalAssetPath() output, the only form a
  // fetched asset can present.
  // ---------------------------------------------------------------------
  it('two paths colliding under NFC/NFD normalisation', async () => {
    // 'e' with acute: one codepoint (NFC) vs 'e' + combining accent (NFD).
    const nfc = canonicalAssetPath('https://x.example/café.js')
    const nfd = canonicalAssetPath('https://x.example/café.js')
    expect(nfc).toBe('/caf%C3%A9.js')
    expect(nfd).toBe('/cafe%CC%81.js')
    await expect(
      bundleHash([manifestEntry(), { path: nfc!, content: utf8('1') }, { path: nfd!, content: utf8('2') }])
    ).rejects.toMatchObject({ code: 'invalid' })
  })

  it('two NON-ASCII paths colliding under case folding', async () => {
    const upper = canonicalAssetPath('https://x.example/Ä.js')
    const lower = canonicalAssetPath('https://x.example/ä.js')
    expect(upper).toBe('/%C3%84.js')
    expect(lower).toBe('/%C3%A4.js')
    await expect(
      bundleHash([manifestEntry(), { path: upper!, content: utf8('1') }, { path: lower!, content: utf8('2') }])
    ).rejects.toMatchObject({ code: 'invalid' })
  })

  // The sharpest case: a SECOND manifest smuggled in under a percent-escaped
  // spelling of the reserved path. Both survive into the pinned asset set, both
  // decode to one filename in the code cache, and whichever wins the write is
  // the manifest whose capabilities are actually enforced -- under a root the
  // user consented to for the other one. Precisely what ADR-0009 chose
  // manifest-as-leaf to prevent.
  it('a percent-escaped alias of the reserved manifest path', async () => {
    await expect(
      bundleHash([
        manifestEntry(),
        { path: '/%2Ewell-known/orivon.json', content: utf8('{"connect":["*:*"]}') }
      ])
    ).rejects.toMatchObject({ code: 'invalid' })
  })

  it('escape aliasing of an ordinary asset (/A.js vs /%41.js)', async () => {
    await expect(
      bundleHash([manifestEntry(), { path: '/A.js', content: utf8('1') }, { path: '/%41.js', content: utf8('2') }])
    ).rejects.toMatchObject({ code: 'invalid' })
  })

  it('hex-case aliasing of one escape (/%C3%A4.js vs /%c3%a4.js)', async () => {
    await expect(
      bundleHash([
        manifestEntry(),
        { path: '/%C3%A4.js', content: utf8('1') },
        { path: '/%c3%a4.js', content: utf8('2') }
      ])
    ).rejects.toMatchObject({ code: 'invalid' })
  })

  // An encoded separator and a real one land on the same file on disk, even
  // though bundle-hash.md is explicit that they are DISTINCT canonical paths
  // for hashing. Both statements are true: they hash apart, and they cannot
  // coexist inside one bundle.
  it('an encoded separator colliding with a real one (/a%2Fb vs /a/b)', async () => {
    await expect(
      bundleHash([manifestEntry(), { path: '/a%2Fb', content: utf8('1') }, { path: '/a/b', content: utf8('2') }])
    ).rejects.toMatchObject({ code: 'invalid' })
  })

  // ---------------------------------------------------------------------
  // THE CANONICAL-FORM RULE (bundle-hash.md rejection table item 5).
  // Stated in the spec from the start and never implemented. Every path below
  // was previously ACCEPTED and hashed into a pin no request could ever match.
  // ---------------------------------------------------------------------
  it('a path not already in canonical form is rejected, not repaired', async () => {
    for (const path of [
      '/a b.js', // real form is /a%20b.js
      '/ä.js', // real form is /%C3%A4.js
      '/%2e%2e/x.js', // URL normalisation collapses this to /x.js
      '/x.js ', // trailing space
      '/a b.js', // line separator, percent-encoded by new URL()
      '/a?b.js', // '?' opens a query, so it cannot occur in a pathname
      '/a#b.js' // '#' opens a fragment
    ]) {
      await expect(
        bundleHash([manifestEntry(), { path, content: utf8('x') }]),
        `should reject ${JSON.stringify(path)}`
      ).rejects.toMatchObject({ code: 'invalid' })
    }
  })

  it('a path whose percent-escapes cannot be decoded', async () => {
    // Canonical as far as the URL parser is concerned -- it passes '%zz'
    // through untouched -- but no filename can be recovered from it, and
    // collisionKey must never be handed something that throws.
    for (const path of ['/%zz.js', '/%e0%a4%a', '/%.js']) {
      await expect(
        bundleHash([manifestEntry(), { path, content: utf8('x') }]),
        `should reject ${JSON.stringify(path)}`
      ).rejects.toMatchObject({ code: 'invalid' })
    }
  })

  // ---------------------------------------------------------------------
  // THE DECODED FORM IS WHAT THE FILESYSTEM SEES.
  //
  // Added 2026-08-27 after adversarial review of the first round of fixes,
  // which decoded percent-escapes for COLLISION detection and then validated
  // only the ENCODED form -- half an argument. If the decoded form is what
  // aliases on disk (the entire reason collisionKey decodes), it is also what
  // has to be safe. `/%00.js` and `/..%2F..%2Fevil.js` were accepted by the
  // first round, hashed, and written into the pinned asset set that ADR-0009
  // makes the code cache's layout map.
  //
  // Rejected on EVERY platform, not only the one where each bites, for the
  // reason paths.ts gives for the same choice: a security boundary whose
  // semantics vary by OS is one nobody can reason about.
  // ---------------------------------------------------------------------
  it('a path whose DECODED form carries a control character', async () => {
    for (const path of ['/%00.js', '/a%00b.js', '/%01.js', '/a%0Ab.js', '/a%7Fb.js']) {
      await expect(
        bundleHash([manifestEntry(), { path, content: utf8('x') }]),
        `should reject ${JSON.stringify(path)}`
      ).rejects.toMatchObject({ code: 'invalid' })
    }
  })

  it('a path whose DECODED form is a traversal', async () => {
    for (const path of ['/..%2F..%2Fevil.js', '/%2E%2E/evil.js', '/a/%2e%2e/b.js', '/%2E/b.js']) {
      await expect(
        bundleHash([manifestEntry(), { path, content: utf8('x') }]),
        `should reject ${JSON.stringify(path)}`
      ).rejects.toMatchObject({ code: 'invalid' })
    }
  })

  // '\' is a separator on Windows, a supported run-from-source target. This is
  // the '%2F' row of the collision table one character over: '/a/b.js' and
  // '/a%5Cb.js' are two leaves under one root and one file on disk, and which
  // one wins is a write-order race.
  it('a path whose DECODED form contains a backslash', async () => {
    await expect(
      bundleHash([manifestEntry(), { path: '/a%5Cb.js', content: utf8('x') }])
    ).rejects.toMatchObject({ code: 'invalid' })
  })

  // '/a//b.js' is '/a/b.js' on every filesystem there is -- no platform caveat.
  it('a path with an empty segment', async () => {
    for (const path of ['/a//b.js', '//a.js', '/a/']) {
      await expect(
        bundleHash([manifestEntry(), { path, content: utf8('x') }]),
        `should reject ${JSON.stringify(path)}`
      ).rejects.toMatchObject({ code: 'invalid' })
    }
  })

  // Win32 strips trailing dots and spaces from a final component, so all of
  // '/a.js', '/a.js.' and '/a.js%20' name one file there. The first round
  // caught '/a.js.' against '/a.js%2E' and missed it against '/a.js' -- a rule
  // half-firing, which reads as covered and is not.
  it('a path component with a trailing dot or space', async () => {
    for (const path of ['/a.js.', '/a.js%20', '/a%20', '/dir./b.js', '/dir%20/b.js']) {
      await expect(
        bundleHash([manifestEntry(), { path, content: utf8('x') }]),
        `should reject ${JSON.stringify(path)}`
      ).rejects.toMatchObject({ code: 'invalid' })
    }
  })

  // Same list paths.ts already refuses, for the same reason and on the same
  // every-platform basis.
  it('a Windows reserved device name', async () => {
    for (const path of ['/CON', '/nul', '/COM1', '/AUX.txt', '/dir/PRN.js', '/LPT9']) {
      await expect(
        bundleHash([manifestEntry(), { path, content: utf8('x') }]),
        `should reject ${JSON.stringify(path)}`
      ).rejects.toMatchObject({ code: 'invalid' })
    }
  })

  // ':' opens an NTFS alternate data stream: 'a.js:hidden' writes bytes that
  // 'a.js' does not show. Legal in a URL path and vanishingly rare in a real
  // asset name, so this rejects loudly at install rather than silently
  // producing a pin whose cache write means something different on Windows.
  it('a path whose DECODED form contains a colon or a pipe', async () => {
    for (const path of ['/a.js:hidden', '/a%3Ahidden.js', '/a%7Cb.js']) {
      await expect(
        bundleHash([manifestEntry(), { path, content: utf8('x') }]),
        `should reject ${JSON.stringify(path)}`
      ).rejects.toMatchObject({ code: 'invalid' })
    }
  })

  it('the bare root path, which names the cache directory rather than a file', async () => {
    await expect(bundleHash([manifestEntry(), { path: '/', content: utf8('x') }])).rejects.toMatchObject({
      code: 'invalid'
    })
  })

  // Guard against over-correction: these are ordinary and must still hash.
  it('accepts the ordinary asset paths a real frontend serves', async () => {
    const entries: BundleEntry[] = [
      manifestEntry(),
      { path: '/index.html', content: utf8('1') },
      { path: '/assets/index-CJ1a1Q2B.js', content: utf8('2') },
      { path: '/fonts/Inter%20Regular.woff2', content: utf8('3') }, // a real space
      { path: '/img/logo@2x.png', content: utf8('4') },
      { path: '/img/icon-192x192.png', content: utf8('5') },
      { path: '/_next/static/chunks/main-app.js', content: utf8('6') },
      { path: '/a.b.c/d.e.f.js', content: utf8('7') },
      { path: '/%C3%A4.js', content: utf8('8') }, // encoded non-ASCII
      { path: '/CONFIG.js', content: utf8('9') }, // NOT the CON device
      { path: '/prnt.js', content: utf8('10') } // NOT the PRN device
    ]
    await expect(bundleHash(entries)).resolves.toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('bounds the rejection message rather than echoing a hostile path whole', async () => {
    const huge = '/' + 'a'.repeat(3_000_000)
    await expect(
      bundleHash([manifestEntry(), { path: huge, content: utf8('x') }])
    ).rejects.toSatisfy((error: Error) => error.message.length < 2048)
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

  // A `file:` URL parses fine and has a pathname that reads exactly like an
  // asset path -- `file:///etc/passwd` yields `/etc/passwd`. An app asset is
  // fetched over https (ADR-0007) or, for the dev fixture, http on localhost;
  // nothing else may produce a canonical path at all.
  it('returns null for a scheme an asset cannot be fetched over', () => {
    expect(canonicalAssetPath('file:///etc/passwd')).toBeNull()
    expect(canonicalAssetPath('data:text/html,hi')).toBeNull()
    expect(canonicalAssetPath('javascript:alert(1)')).toBeNull()
    expect(canonicalAssetPath('orivon-app:///index.html')).toBeNull()
    expect(canonicalAssetPath('ftp://x.example/a.js')).toBeNull()
  })

  it('accepts the two schemes an asset can be fetched over', () => {
    expect(canonicalAssetPath('https://x.example/a.js')).toBe('/a.js')
    expect(canonicalAssetPath('http://localhost:5173/a.js')).toBe('/a.js')
  })

  it('rejects an over-length path', () => {
    const longPath = '/' + 'a'.repeat(2000) + '.js'
    expect(canonicalAssetPath(`https://x.example${longPath}`)).toBeNull()
  })
})
