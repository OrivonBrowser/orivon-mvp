import { describe, expect, it } from 'vitest'
import { parseManifest, type ManifestResult } from '../manifest.js'

// Split out of manifest.test.ts (code-guidelines.md Rule 2's line limit),
// the same reason unknown-fields.test.ts is its own file: this is
// one field's grammar, not a general shape of the manifest validator.

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

describe('tcp.listen / udp.bind -- port ranges (ADR-0034)', () => {
  const netWith = (listen: unknown): Record<string, unknown> =>
    withCapabilities({ net: { tcp: { listen } } })

  it('refuses the old, pre-ADR-0034 bare-array shape', () => {
    expect(reason(parseManifest(withCapabilities({ net: { tcp: { listen: ['6881-6889'] } } })))).toMatch(/must be an object/)
  })

  it('refuses an empty BindScopes -- neither "local" nor "network" present', () => {
    expect(reason(parseManifest(netWith({})))).toMatch(/must declare "local", "network" or both/)
  })

  it('refuses an unrecognised key inside BindScopes', () => {
    expect(reason(parseManifest(netWith({ everywhere: ['6881-6889'] })))).toMatch(/unrecognised field: "everywhere"/)
  })

  it('accepts "local" alone, "network" alone, or both together', () => {
    expect(parseManifest(netWith({ local: ['8080'] })).ok).toBe(true)
    expect(parseManifest(netWith({ network: ['6881-6889'] })).ok).toBe(true)
    expect(parseManifest(netWith({ local: ['8080'], network: ['6881-6889'] })).ok).toBe(true)
  })

  it('rejects "*" for tcp.listen', () => {
    expect(reason(parseManifest(netWith({ network: ['*'] })))).toMatch(/declared port range is required/)
  })

  it('rejects a privileged port (below 1024)', () => {
    expect(reason(parseManifest(netWith({ network: ['80'] })))).toMatch(/privileged ports below 1024/)
  })

  it('rejects the top of the privileged range, 1023', () => {
    expect(reason(parseManifest(netWith({ network: ['1023'] })))).toMatch(/privileged/)
  })

  it('accepts the first unprivileged port, 1024', () => {
    expect(parseManifest(netWith({ network: ['1024'] })).ok).toBe(true)
  })

  it('rejects a range that starts privileged even if it ends high', () => {
    expect(reason(parseManifest(netWith({ network: ['1000-2000'] })))).toMatch(/privileged/)
  })

  it('accepts a normal range', () => {
    expect(parseManifest(netWith({ network: ['6881-6889'] })).ok).toBe(true)
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
    expect(reason(parseManifest(netWith({ network: [spec] })))).toMatch(/not a valid port|privileged|not a valid host/)
  })

  it('rejects an empty array -- omit the field instead', () => {
    expect(reason(parseManifest(netWith({ network: [] })))).toMatch(/must not be empty/)
  })

  it('rejects more than 256 entries', () => {
    const many = Array.from({ length: 257 }, (_, i) => String(1024 + i))
    expect(reason(parseManifest(netWith({ network: many })))).toMatch(/more than the 256 allowed/)
  })

  it('rejects a non-array value', () => {
    expect(reason(parseManifest(netWith({ network: '6881-6889' })))).toMatch(/must be an array/)
  })

  it('rejects a non-string element', () => {
    expect(reason(parseManifest(netWith({ network: [6881] })))).toMatch(/must be a string/)
  })

  it('applies the identical rule to udp.bind', () => {
    const raw = withCapabilities({ net: { udp: { bind: { network: ['*'] } } } })
    expect(reason(parseManifest(raw))).toMatch(/declared port range is required/)

    const privileged = withCapabilities({ net: { udp: { bind: { network: ['22'] } } } })
    expect(reason(parseManifest(privileged))).toMatch(/privileged/)

    const ok = withCapabilities({ net: { udp: { bind: { network: ['6881-6889'] } } } })
    expect(parseManifest(ok).ok).toBe(true)
  })
})
