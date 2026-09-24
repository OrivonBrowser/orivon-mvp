import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildHostResolverRules, buildSecureOriginList, readDevEthNames } from '../eth-resolver.js'

describe('buildHostResolverRules', () => {
  it('builds one MAP clause per name, to its own port', () => {
    expect(buildHostResolverRules({ 'freetube.eth': 8875, 'asgardex.eth': 8876 }))
      .toBe('MAP freetube.eth 127.0.0.1:8875,MAP asgardex.eth 127.0.0.1:8876')
  })

  it('is empty for an empty map', () => {
    expect(buildHostResolverRules({})).toBe('')
  })

  // Appended verbatim to a command-line switch -- a key or value that is not
  // exactly this shape is dropped rather than trusted, since this file
  // reads a names map from OUTSIDE this process.
  it('drops a name that is not a plain "label.eth"', () => {
    for (const bad of ['freetube', 'FreeTube.eth', 'sub.freetube.eth', 'freetube.com', 'freetube.eth,MAP evil.com 1.2.3.4:80']) {
      expect(buildHostResolverRules({ [bad]: 8875 })).toBe('')
    }
  })

  it('drops a non-integer, out-of-range, or non-numeric port', () => {
    for (const bad of [0, -1, 65536, 8875.5, Number.NaN]) {
      expect(buildHostResolverRules({ 'freetube.eth': bad })).toBe('')
    }
    expect(buildHostResolverRules({ 'freetube.eth': '8875' as unknown as number })).toBe('')
  })

  it('keeps the valid entries and drops only the bad ones', () => {
    expect(buildHostResolverRules({ 'freetube.eth': 8875, 'Bad.eth': 1, 'asgardex.eth': 8876 }))
      .toBe('MAP freetube.eth 127.0.0.1:8875,MAP asgardex.eth 127.0.0.1:8876')
  })
})

describe('buildSecureOriginList', () => {
  it('builds one http origin per name', () => {
    expect(buildSecureOriginList({ 'freetube.eth': 8875, 'asgardex.eth': 8876 }))
      .toBe('http://freetube.eth,http://asgardex.eth')
  })

  it('is empty for an empty map', () => {
    expect(buildSecureOriginList({})).toBe('')
  })

  // Spliced into a command-line switch exactly as the MAP clauses are, so
  // the same names file that cannot inject there cannot inject here.
  it('drops a name that is not a plain "label.eth"', () => {
    for (const bad of ['freetube', 'FreeTube.eth', 'sub.freetube.eth', 'freetube.com', 'freetube.eth,MAP evil.com 1.2.3.4:80']) {
      expect(buildSecureOriginList({ [bad]: 8875 })).toBe('')
    }
  })

  // The property that matters more than either list on its own: a name
  // Chromium is told to trust must be a name this process also mapped to
  // loopback. An entry accepted by one and dropped by the other would
  // declare a name the machine's real resolver answers to be a secure
  // context.
  it('accepts exactly the names host-resolver-rules maps, never a superset', () => {
    const names = { 'freetube.eth': 8875, 'Bad.eth': 1, 'asgardex.eth': 8876, 'nope.eth': 99999 }
    expect(buildSecureOriginList(names)).toBe('http://freetube.eth,http://asgardex.eth')
    expect(buildHostResolverRules(names))
      .toBe('MAP freetube.eth 127.0.0.1:8875,MAP asgardex.eth 127.0.0.1:8876')
  })
})

describe('readDevEthNames', () => {
  let dir: string
  const ORIGINAL_ENV = { ...process.env }
  const NONE = { rules: '', secureOrigins: '' }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orivon-eth-resolver-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    process.env = { ...ORIGINAL_ENV }
  })

  const namesFile = (content: string): string => {
    const path = join(dir, 'names.json')
    writeFileSync(path, content)
    return path
  }

  it('reads nothing when ORIVON_DEV_ORIGINS is not set, even with a valid file', () => {
    delete process.env['ORIVON_DEV_ORIGINS']
    process.env['ORIVON_ETH_NAMES_FILE'] = namesFile('{"freetube.eth": 8875}')
    expect(readDevEthNames()).toEqual(NONE)
  })

  it('reads nothing when ORIVON_ETH_NAMES_FILE is not set, even in dev mode', () => {
    process.env['ORIVON_DEV_ORIGINS'] = '1'
    delete process.env['ORIVON_ETH_NAMES_FILE']
    expect(readDevEthNames()).toEqual(NONE)
  })

  // Without the secure-origin list the mapped name is plain http: on a
  // non-loopback host, so the page loses navigator.clipboard, crypto.subtle,
  // crypto.randomUUID and service workers -- a different app from the same
  // bundle opened at 127.0.0.1.
  it('turns a valid file into resolver clauses and the same names as secure origins', () => {
    process.env['ORIVON_DEV_ORIGINS'] = '1'
    process.env['ORIVON_ETH_NAMES_FILE'] = namesFile('{"freetube.eth": 8875, "asgardex.eth": 8876}')
    expect(readDevEthNames()).toEqual({
      rules: 'MAP freetube.eth 127.0.0.1:8875,MAP asgardex.eth 127.0.0.1:8876',
      secureOrigins: 'http://freetube.eth,http://asgardex.eth'
    })
  })

  // Both values or neither: an entry dropped from the MAP clauses must not
  // still be called trustworthy.
  it('never declares an origin it did not also map to loopback', () => {
    process.env['ORIVON_DEV_ORIGINS'] = '1'
    process.env['ORIVON_ETH_NAMES_FILE'] = namesFile('{"freetube.eth": 8875, "Bad.eth": 1}')
    expect(readDevEthNames()).toEqual({ rules: 'MAP freetube.eth 127.0.0.1:8875', secureOrigins: 'http://freetube.eth' })
  })

  it('reads nothing from an empty names file', () => {
    process.env['ORIVON_DEV_ORIGINS'] = '1'
    process.env['ORIVON_ETH_NAMES_FILE'] = namesFile('{}')
    expect(readDevEthNames()).toEqual(NONE)
  })

  // A missing or malformed file is a dev mistake, not a reason to crash the
  // shell -- console.error is enough, and this proves that path does not throw.
  it('does not throw on a missing file, and reads nothing', () => {
    process.env['ORIVON_DEV_ORIGINS'] = '1'
    process.env['ORIVON_ETH_NAMES_FILE'] = join(dir, 'does-not-exist.json')
    expect(readDevEthNames()).toEqual(NONE)
  })

  it('does not throw on malformed JSON, or JSON that is not an object map', () => {
    process.env['ORIVON_DEV_ORIGINS'] = '1'
    for (const content of ['not json', '[1, 2, 3]', '"a string"', 'null']) {
      process.env['ORIVON_ETH_NAMES_FILE'] = namesFile(content)
      expect(readDevEthNames()).toEqual(NONE)
    }
  })
})
