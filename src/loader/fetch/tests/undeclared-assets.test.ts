import { describe, expect, it, vi } from 'vitest'
import { createLoader } from '../../index.js'
import { undeclaredReferences } from '../undeclared-assets.js'
import { MANIFEST_URL, ORIGIN, PUBLIC_RESOLVER, manifestJson, memoryStorage, stubFetch, utf8 } from '../../tests/test-helpers.js'

describe('undeclaredReferences', () => {
  it('names same-origin subresources the pinned set lacks, and nothing else', () => {
    const html = `<!doctype html>
      <link rel="stylesheet" href="/assets/app.css">
      <script type="module" src='assets/app.js'></script>
      <script src=/vendor.js?v=3></script>
      <img src="https://cdn.example/logo.png">
      <img src="data:image/png;base64,AAAA">
      <a href="/about">about</a>
      <link rel="icon" href="/favicon.ico">`
    const pinned = new Set(['/index.html', '/assets/app.css'])

    expect(undeclaredReferences(html, `${ORIGIN}/index.html`, pinned)).toEqual(['/assets/app.js', '/favicon.ico', '/vendor.js'])
  })
})

describe('install: the undeclared-asset warning', () => {
  it('warns at install, naming the undeclared file, and still installs', async () => {
    const routes = {
      [MANIFEST_URL]: { body: utf8(manifestJson()) },
      [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html><script src="/main.js"></script>') }
    }
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const loader = createLoader({ fetch: stubFetch(routes), storage: memoryStorage(), now: () => 0, resolve: PUBLIC_RESOLVER })

    const result = await loader.load(ORIGIN, { grantedPatterns: {}, versionFloor: '0.0.0', acknowledgedRollbackVersion: undefined })

    expect(result.outcome).toBe('installed')
    expect(warned.mock.calls.map((call) => String(call[0])).join('\n')).toContain('/main.js')
    warned.mockRestore()
  })
})
