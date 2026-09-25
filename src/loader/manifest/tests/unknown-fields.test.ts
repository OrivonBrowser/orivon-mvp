import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseManifest, type ManifestResult } from '../manifest.js'
import { fetchBundle } from '../../fetch/bundle.js'
import { MANIFEST_URL, ORIGIN, PUBLIC_RESOLVER, manifestJson, memoryStorage, stubFetch, utf8 } from '../../tests/test-helpers.js'

// A top-level field this parser does not know is ignored and named, so a
// manifest carrying `$schema`, `description` or a field a later Orivon adds
// still installs, and a pinned manifest re-parsed at start never locks its
// app out. Inside `capabilities` the parser stays strict: dropping a
// permission the app asked for would be worse than refusing the manifest.

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

function accepted (result: ManifestResult): Extract<ManifestResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected acceptance, got: ${result.reason}`)
  return result
}

function reason (result: ManifestResult): string {
  if (result.ok) throw new Error('expected a rejection, got ok:true')
  return result.reason
}

describe('unknown top-level fields', () => {
  it('accepts a manifest carrying $schema, description, icons, homepage and a future field', () => {
    const result = accepted(parseManifest(minimal({
      $schema: 'https://orivon.example/manifest.schema.json',
      description: 'A test app',
      icons: [{ src: 'icon.png', sizes: '192x192' }],
      homepage: 'https://example.com',
      futureField: { anything: true }
    })))
    expect(result.ignoredFields).toEqual(['$schema', 'description', 'icons', 'homepage', 'futureField'])
  })

  it('leaves an ignored field out of the parsed manifest entirely', () => {
    const result = accepted(parseManifest(minimal({ description: 'x' })))
    expect(Object.hasOwn(result.manifest, 'description')).toBe(false)
    expect(result.manifest).toEqual(minimal())
  })

  it('reports no ignored field for a manifest that has none', () => {
    expect(accepted(parseManifest(minimal())).ignoredFields).toEqual([])
  })

  it('ignores "__proto__" and "constructor" own keys without polluting anything', () => {
    const raw = JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"evil": true}}') as Record<string, unknown>
    const result = accepted(parseManifest({ ...minimal(), ...raw }))
    expect(result.ignoredFields).toEqual(['__proto__', 'constructor'])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.getPrototypeOf(result.manifest)).toBe(Object.prototype)
  })

  it('never inspects an ignored field\'s value, however deep it nests', () => {
    let nested: unknown = 'bottom'
    for (let i = 0; i < 10_000; i += 1) nested = { wrapper: nested }
    expect(accepted(parseManifest(minimal({ extra: nested }))).ignoredFields).toEqual(['extra'])
  })

  it('still rejects a manifest whose known fields are wrong, whatever else it carries', () => {
    expect(reason(parseManifest(minimal({ description: 'x', orivonApiVersion: 1 })))).toMatch(/orivonApiVersion must be exactly 0/)
    const missing = minimal({ description: 'x' })
    delete missing.orivonApiVersion
    expect(reason(parseManifest(missing))).toMatch(/orivonApiVersion must be exactly 0/)
  })

  it('does not treat a capability declared at the top level as a capability', () => {
    const result = accepted(parseManifest(minimal({ net: { tcp: { connect: ['*:*'] } } })))
    expect(result.ignoredFields).toEqual(['net'])
    expect(result.manifest.capabilities).toEqual({})
  })
})

describe('unknown fields inside capabilities stay a rejection', () => {
  it.each([
    ['capabilities', { shell: true }, 'shell'],
    ['capabilities.net', { net: { raw: true } }, 'raw'],
    ['capabilities.net.tcp', { net: { tcp: { connect: ['*:*'], backdoor: true } } }, 'backdoor'],
    ['capabilities.net.udp', { net: { udp: { send: ['*:*'], multicast: true } } }, 'multicast'],
    ['capabilities.net.https', { net: { https: { connect: ['*:*'], insecure: true } } }, 'insecure'],
    ['capabilities.fs', { fs: { quotaBytes: 1024, root: '/' } }, 'root'],
    ['capabilities.id', { id: { curves: ['secp256k1'], export: true } }, 'export'],
    ['capabilities.web', { web: { contexts: ['https://a.example'], all: true } }, 'all']
  ])('rejects an unrecognised field in %s', (_where, capabilities, field) => {
    expect(reason(parseManifest(minimal({ description: 'ignored', capabilities })))).toMatch(new RegExp(`unrecognised field: "${field}"`))
  })
})

describe('fetchBundle names the ignored fields in a warning', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('warns once, naming each ignored field, and installs anyway', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const routes = {
      [MANIFEST_URL]: { body: utf8(manifestJson({ $schema: 'x', description: 'y' })) },
      [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') }
    }
    const result = await fetchBundle(stubFetch(routes), ORIGIN, PUBLIC_RESOLVER, memoryStorage())
    expect(result.ok).toBe(true)
    const messages = warned.mock.calls.map((call) => call.join(' ')).filter((text) => text.includes('ignored'))
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain(ORIGIN)
    expect(messages[0]).toContain('"$schema"')
    expect(messages[0]).toContain('"description"')
  })

  it('does not warn about a manifest with no unknown field', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const routes = {
      [MANIFEST_URL]: { body: utf8(manifestJson()) },
      [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') }
    }
    await fetchBundle(stubFetch(routes), ORIGIN, PUBLIC_RESOLVER, memoryStorage())
    expect(warned.mock.calls.filter((call) => call.join(' ').includes('ignored'))).toHaveLength(0)
  })
})
