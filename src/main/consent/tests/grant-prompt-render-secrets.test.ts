import { describe, expect, it } from 'vitest'
import { describeCapabilityGrant, describeGrantRequest } from '../grant-prompt-render.js'
import { manifestWith } from '../../../broker/tests/index.test-helpers.js'

// ADR-0031's own consent copy, split into its own sibling file rather than
// grown onto ./grant-prompt-render.test.ts (694/800 lines already) -- the
// same reason grant-prompt-render-web-context.test.ts exists.

const ORIGIN = 'https://app.example'

describe('describeCapabilityGrant -- secrets (ADR-0031)', () => {
  it('is not a warning -- an app-private, origin-bound secret is the same risk level as fs/id', () => {
    const row = describeCapabilityGrant('secrets', [])
    expect(row.warning).toBe(false)
  })

  it('says what the grant gives without naming the identity seed or a key the app could hold', () => {
    const row = describeCapabilityGrant('secrets', [])
    expect(row.message).toContain('Encrypt')
    expect(row.message).not.toMatch(/identity|seed/i)
  })

  it('describeGrantRequest -- the one-capability prompt renders secrets the same way, through the same function', () => {
    const manifest = manifestWith({ secrets: {} })
    const content = describeGrantRequest(ORIGIN, manifest, 'secrets', [])
    expect(content.warning).toBe(false)
    expect(content.message).toContain('Encrypt')
  })
})
