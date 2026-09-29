import { describe, expect, it, vi } from 'vitest'
import type { OnHeadersReceivedListenerDetails } from 'electron'

const getExtension = vi.fn()

vi.mock('electron', () => ({
  session: { defaultSession: { extensions: { getExtension } } }
}))

// The REAL isSandboxPageUrl's own correctness (glob grammar, normalisation,
// ReDoS/cap limits) is router-sandbox-page-refusal.test.ts's job -- this
// file only needs a stand-in that behaves like it for exact-name entries,
// the only shape these tests use.
vi.mock('orivon:crx-extensions-router', () => ({
  isSandboxPageUrl: (pages: string[] | undefined, url: string) => {
    if (pages === undefined) return false
    const path = new URL(url).pathname.replace(/^\//, '')
    return pages.includes(path)
  }
}))

const { extensionSandboxCsp, CHROME_DEFAULT_SANDBOX_CSP, EXTENSION_SANDBOX_CSP_FILTER } = await import('../extension-sandbox-csp.js')

const EXT_ID = 'a'.repeat(32)

function detailsFor (url: string, resourceType: string): OnHeadersReceivedListenerDetails {
  return { url, resourceType, responseHeaders: {} } as unknown as OnHeadersReceivedListenerDetails
}

describe('extensionSandboxCsp (UPSTREAM.md patch 40)', () => {
  it('appends the default sandbox CSP for a declared sandbox.pages document', async () => {
    getExtension.mockReturnValue({ manifest: { sandbox: { pages: ['sandbox.html'] } } })
    const handler = extensionSandboxCsp()

    const result = await handler(detailsFor(`chrome-extension://${EXT_ID}/sandbox.html`, 'mainFrame'), { responseHeaders: {} })

    expect(result.responseHeaders['Content-Security-Policy']).toContain(CHROME_DEFAULT_SANDBOX_CSP)
  })

  it('uses the manifest\'s own content_security_policy.sandbox override when given', async () => {
    getExtension.mockReturnValue({
      manifest: { sandbox: { pages: ['sandbox.html'] }, content_security_policy: { sandbox: 'sandbox; script-src *' } }
    })
    const handler = extensionSandboxCsp()

    const result = await handler(detailsFor(`chrome-extension://${EXT_ID}/sandbox.html`, 'mainFrame'), { responseHeaders: {} })

    expect(result.responseHeaders['Content-Security-Policy']).toEqual(['sandbox; script-src *'])
  })

  it('falls back to Chrome\'s default sandbox CSP when the manifest\'s own override has no "sandbox" directive at all -- Chrome rejects such a value outright', async () => {
    getExtension.mockReturnValue({
      manifest: { sandbox: { pages: ['sandbox.html'] }, content_security_policy: { sandbox: "script-src 'self'" } }
    })
    const handler = extensionSandboxCsp()

    const result = await handler(detailsFor(`chrome-extension://${EXT_ID}/sandbox.html`, 'mainFrame'), { responseHeaders: {} })

    expect(result.responseHeaders['Content-Security-Policy']).toContain(CHROME_DEFAULT_SANDBOX_CSP)
  })

  it('accepts an override whose "sandbox" directive is not the first one, and is cased differently', async () => {
    getExtension.mockReturnValue({
      manifest: { sandbox: { pages: ['sandbox.html'] }, content_security_policy: { sandbox: "script-src 'self'; SANDBOX allow-scripts" } }
    })
    const handler = extensionSandboxCsp()

    const result = await handler(detailsFor(`chrome-extension://${EXT_ID}/sandbox.html`, 'mainFrame'), { responseHeaders: {} })

    expect(result.responseHeaders['Content-Security-Policy']).toEqual(["script-src 'self'; SANDBOX allow-scripts"])
  })

  it('leaves an ordinary (non-sandbox) extension page completely untouched', () => {
    getExtension.mockReturnValue({ manifest: { sandbox: { pages: ['sandbox.html'] } } })
    const handler = extensionSandboxCsp()
    const current = { responseHeaders: { 'X-Foo': ['bar'] } }

    const result = handler(detailsFor(`chrome-extension://${EXT_ID}/popup.html`, 'mainFrame'), current)

    expect(result).toBe(current)
  })

  it('leaves an extension with no sandbox.pages at all untouched', () => {
    getExtension.mockReturnValue({ manifest: {} })
    const handler = extensionSandboxCsp()
    const current = { responseHeaders: {} }

    const result = handler(detailsFor(`chrome-extension://${EXT_ID}/sandbox.html`, 'mainFrame'), current)

    expect(result).toBe(current)
  })

  it('never applies to a subresource fetch -- CSP sandbox is a document-level policy', () => {
    getExtension.mockReturnValue({ manifest: { sandbox: { pages: ['sandbox.html'] } } })
    const handler = extensionSandboxCsp()
    const current = { responseHeaders: {} }

    const result = handler(detailsFor(`chrome-extension://${EXT_ID}/sandbox.html`, 'script'), current)

    expect(result).toBe(current)
  })

  it('applies to a subFrame response (a sandbox page framed by another extension page), not only mainFrame', async () => {
    getExtension.mockReturnValue({ manifest: { sandbox: { pages: ['sandbox.html'] } } })
    const handler = extensionSandboxCsp()

    const result = await handler(detailsFor(`chrome-extension://${EXT_ID}/sandbox.html`, 'subFrame'), { responseHeaders: {} })

    expect(result.responseHeaders['Content-Security-Policy']).toContain(CHROME_DEFAULT_SANDBOX_CSP)
  })

  it('the filter scopes to chrome-extension: URLs and document resource types only, including object', () => {
    expect(EXTENSION_SANDBOX_CSP_FILTER.urls).toEqual(['chrome-extension://*/*'])
    expect(EXTENSION_SANDBOX_CSP_FILTER.types).toEqual(['mainFrame', 'subFrame', 'object'])
  })

  it('applies to an object/embed document response (granted-origin-csp.ts\'s own doc: Electron reports a same-origin <object>/<embed> document\'s response with resourceType "object", measured Electron 44) -- a web-accessible sandbox page embedded that way must not skip this CSP', async () => {
    getExtension.mockReturnValue({ manifest: { sandbox: { pages: ['sandbox.html'] } } })
    const handler = extensionSandboxCsp()

    const result = await handler(detailsFor(`chrome-extension://${EXT_ID}/sandbox.html`, 'object'), { responseHeaders: {} })

    expect(result.responseHeaders['Content-Security-Policy']).toContain(CHROME_DEFAULT_SANDBOX_CSP)
  })
})
