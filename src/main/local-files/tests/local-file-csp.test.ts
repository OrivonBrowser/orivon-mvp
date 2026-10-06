import { describe, expect, it } from 'vitest'
import { INERT_FILE_CSP, LOCAL_FILE_CSP, withPolicies } from '../local-file-csp.js'

function directives (policy: string): Map<string, string[]> {
  return new Map(policy.split(';').map((part) => part.trim().split(/\s+/)).map(([name, ...sources]) => [name ?? '', sources]))
}

describe('LOCAL_FILE_CSP', () => {
  const policy = directives(LOCAL_FILE_CSP)

  it('lets a page fetch the web and nothing on this computer', () => {
    expect(policy.get('connect-src')).toEqual(['https:', 'http:', 'wss:', 'ws:', 'blob:', 'data:'])
    expect(LOCAL_FILE_CSP).not.toMatch(/file:/)
  })

  it('allows frames of the web only, workers of blob and data only, and no plugin', () => {
    expect(policy.get('frame-src')).toEqual(['https:', 'http:', 'blob:', 'data:'])
    expect(policy.get('worker-src')).toEqual(['blob:', 'data:'])
    expect(policy.get('object-src')).toEqual(["'none'"])
  })

  it('does not restrict what the page itself loads: no default-src, script-src or img-src', () => {
    for (const name of ['default-src', 'script-src', 'style-src', 'img-src', 'font-src', 'media-src']) expect(policy.has(name)).toBe(false)
  })
})

describe('INERT_FILE_CSP', () => {
  it('sandboxes the document and allows nothing to load', () => {
    expect(INERT_FILE_CSP).toBe("sandbox; default-src 'none'")
  })
})

describe('withPolicies', () => {
  it('adds each policy as its own header, keeping what was there', () => {
    const base = new Headers({ 'content-type': 'text/html', 'content-security-policy': 'img-src data:' })

    const result = withPolicies(base, [LOCAL_FILE_CSP, "default-src 'self'"])

    expect(result.get('content-type')).toBe('text/html')
    expect(result.get('content-security-policy')).toBe(`img-src data:, ${LOCAL_FILE_CSP}, default-src 'self'`)
  })

  it('does not change the headers it was given', () => {
    const base = new Headers({ a: 'b' })
    withPolicies(base, ['x'])
    expect(base.has('content-security-policy')).toBe(false)
  })
})
