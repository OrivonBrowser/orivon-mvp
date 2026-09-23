import { describe, expect, it } from 'vitest'
import { parseManifest, type ManifestResult } from '../manifest.js'

// PR #192 added `Manifest.consentGranularity` (src/contracts/manifest.ts) but
// this parser's own MANIFEST_KEYS allowlist never learned the name -- so
// readManifest's own extraKey check (this file's header: "rejects any field
// it does not recognise") refused every manifest that used the field the
// contract itself documents, blaming the app author for following the
// contract. Closing that trap is this suite's whole job; docs/open-
// questions.md A138 is the field's own design rationale, not repeated here.

/** Required fields only, `capabilities: {}` -- mirrors manifest.test.ts's own helper of the same name (that file's local fixture is not exported, so this is a second, deliberately small copy, not a shared one -- code-guidelines.md Rule 3 is about helper LOGIC, not a five-field object literal). */
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

function reason (result: ManifestResult): string {
  if (result.ok) throw new Error('expected a rejection, got ok:true')
  return result.reason
}

describe('consentGranularity', () => {
  it('accepts "all-or-nothing"', () => {
    const result = parseManifest(minimal({ consentGranularity: 'all-or-nothing' }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest.consentGranularity).toBe('all-or-nothing')
  })

  it('accepts "per-capability"', () => {
    const result = parseManifest(minimal({ consentGranularity: 'per-capability' }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest.consentGranularity).toBe('per-capability')
  })

  it('omitting the field is legal, and the parsed manifest carries no key for it -- the contract\'s own "omitted means all-or-nothing" is a caller-side default, not a value this parser invents', () => {
    const result = parseManifest(minimal())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.manifest.consentGranularity).toBeUndefined()
    expect(Object.hasOwn(result.manifest, 'consentGranularity')).toBe(false)
  })

  it('rejects an unrecognised value clearly, naming the field and the value', () => {
    const result = parseManifest(minimal({ consentGranularity: 'per-item' }))
    expect(result.ok).toBe(false)
    expect(reason(result)).toMatch(/consentGranularity/)
    expect(reason(result)).toMatch(/"per-item"/)
  })

  it('rejects a number (coercion/wrong-type trap)', () => {
    expect(reason(parseManifest(minimal({ consentGranularity: 1 })))).toMatch(/consentGranularity/)
  })

  it('rejects null', () => {
    expect(reason(parseManifest(minimal({ consentGranularity: null })))).toMatch(/consentGranularity/)
  })

  it('rejects the empty string', () => {
    expect(reason(parseManifest(minimal({ consentGranularity: '' })))).toMatch(/consentGranularity/)
  })

  it('rejects a near-miss spelling ("all-or-nothing " with trailing whitespace, "All-Or-Nothing" wrong case) -- exactly one canonical spelling per value', () => {
    expect(reason(parseManifest(minimal({ consentGranularity: 'all-or-nothing ' })))).toMatch(/consentGranularity/)
    expect(reason(parseManifest(minimal({ consentGranularity: 'All-Or-Nothing' })))).toMatch(/consentGranularity/)
  })

  // The trap this whole suite exists to close: a field MANIFEST_KEYS does not
  // know is dropped as unrecognised -- correct usage of the documented
  // contract, discarded as if the app author had made it up.
  it('is a recognised top-level field, not ignored as unrecognised', () => {
    const result = parseManifest(minimal({ consentGranularity: 'per-capability' }))
    if (!result.ok) throw new Error(result.reason)
    expect(result.ignoredFields).toEqual([])
  })
})
