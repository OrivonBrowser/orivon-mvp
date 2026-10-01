import { X509Certificate } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createRunCertificate } from '../../../protocols/verifier-host/serve/certificate.js'
import type { OverlayHandler, OverlayWindow } from '../../overlays/overlay-types.js'
import { CertificateCache, MAX_HOSTS } from '../certificate-cache.js'
import { activeHttpsHost, certificateAvailable, hostsOfTabs, httpsHostOf, openCertificate } from '../certificate-open.js'
import { certificateOverlayFor } from '../certificate-overlay.js'
import type { CertificatePage } from '../certificate-overlay.js'
import { chainOf, MAX_CHAIN, sha256Of } from '../certificate-view.js'
import type { CertificateLike } from '../certificate-view.js'
import { noteInto } from '../note-certificate.js'

function like (name: string, issuer?: CertificateLike): CertificateLike {
  const made = createRunCertificate(new Date('2026-09-01T00:00:00Z'), 30, `${name}.test`)
  const x509 = new X509Certificate(made.certPem)
  return {
    data: made.certPem,
    fingerprint: made.fingerprint,
    issuer: { commonName: 'Issuer CA', organizations: ['Issuer Org'] },
    issuerCert: issuer,
    issuerName: 'Issuer CA',
    serialNumber: x509.serialNumber,
    subject: { commonName: name, organizations: ['Subject Org'] },
    subjectName: name,
    validStart: Date.parse(x509.validFrom) / 1000,
    validExpiry: Date.parse(x509.validTo) / 1000
  }
}

describe('certificate views', () => {
  it('reads display fields and the SHA-256 of the DER, as the platform computes it', () => {
    const leaf = like('leaf')
    const [view] = chainOf(leaf)
    expect(view?.subject).toEqual({ commonName: 'leaf', organization: 'Subject Org' })
    expect(view?.issuer).toEqual({ commonName: 'Issuer CA', organization: 'Issuer Org' })
    expect(view?.fingerprint).toBe(new X509Certificate(leaf.data).fingerprint256)
    expect(sha256Of(leaf.data)).toBe(view?.fingerprint)
    expect(view?.serial.replace(/:/g, '')).toBe(new X509Certificate(leaf.data).serialNumber.padStart(view?.serial.replace(/:/g, '').length ?? 0, '0'))
    expect(view?.validUntil).toBeGreaterThan(view?.validFrom ?? 0)
    expect(view?.pem).toBe(leaf.data)
  })

  it('follows the issuers, leaf first, and stops at the depth limit and at a repeat', () => {
    const root = like('root')
    const mid = like('mid', root)
    expect(chainOf(like('leaf', mid)).map((view) => view.subject.commonName)).toEqual(['leaf', 'mid', 'root'])
    let deep = like('c0')
    for (let i = 1; i < 12; i++) deep = like(`c${String(i)}`, deep)
    expect(chainOf(deep)).toHaveLength(MAX_CHAIN)
    const loop = { ...like('loop') } as { -readonly [K in keyof CertificateLike]: CertificateLike[K] }
    loop.issuerCert = loop
    expect(chainOf(loop)).toHaveLength(1)
  })

  it('sha256Of is empty for text that is not a certificate', () => {
    expect(sha256Of('')).toBe('')
    expect(sha256Of('-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----')).toBe('')
  })

  it('falls back to the name when the principal has no common name', () => {
    const base = like('x')
    const [view] = chainOf({ ...base, subject: { commonName: '', organizations: [] }, subjectName: 'fallback' })
    expect(view?.subject).toEqual({ commonName: 'fallback', organization: '' })
  })
})

describe('CertificateCache', () => {
  it('keeps the newest hosts and drops the one used longest ago', () => {
    const cache = new CertificateCache(() => 1)
    const chain = chainOf(like('a'))
    for (let i = 0; i < MAX_HOSTS; i++) cache.set(`h${String(i)}.test`, chain)
    expect(cache.get('h0.test')).toBeDefined()
    cache.set('extra.test', chain)
    expect(cache.size).toBe(MAX_HOSTS)
    expect(cache.get('h1.test')).toBeUndefined()
    expect(cache.get('h0.test')).toBeDefined()
    expect(cache.get('EXTRA.test')).toMatchObject({ at: 1 })
  })

  it('keeps the host of a page on screen however many others connect', () => {
    const cache = new CertificateCache(() => 1)
    const chain = chainOf(like('a'))
    cache.keepHosts(() => new Set(['h0.test']))
    for (let i = 0; i < MAX_HOSTS + 20; i++) cache.set(`h${String(i)}.test`, chain)
    expect(cache.size).toBe(MAX_HOSTS)
    expect(cache.get('h0.test')).toBeDefined()
    expect(cache.get('h1.test')).toBeUndefined()
  })

  it('never lets a connection that was not accepted replace the chain of one that was', () => {
    const cache = new CertificateCache()
    cache.set('a.test', chainOf(like('good')), true)
    cache.set('a.test', chainOf(like('intercepted')), false)
    expect(cache.get('a.test')?.chain[0]?.subject.commonName).toBe('good')
    cache.set('a.test', chainOf(like('renewed')), true)
    expect(cache.get('a.test')?.chain[0]?.subject.commonName).toBe('renewed')
    cache.set('b.test', chainOf(like('first')), false)
    cache.set('b.test', chainOf(like('second')), false)
    expect(cache.get('b.test')).toMatchObject({ trusted: false })
    expect(cache.get('b.test')?.chain[0]?.subject.commonName).toBe('second')
  })

  it('stores nothing for an empty host or chain', () => {
    const cache = new CertificateCache()
    cache.set('', chainOf(like('a')))
    cache.set('a.test', [])
    expect(cache.size).toBe(0)
  })
})

describe('noteCertificate', () => {
  it('records the chain for the host and does not walk it again for the same certificate', () => {
    const cache = new CertificateCache()
    const leaf = like('leaf', like('root'))
    noteInto(cache, 'Leaf.test', true, [leaf])
    expect(cache.get('leaf.test')?.chain).toHaveLength(2)
    const chain = cache.get('leaf.test')?.chain
    noteInto(cache, 'leaf.test', true, [leaf])
    expect(cache.get('leaf.test')?.chain).toBe(chain)
    noteInto(cache, 'leaf.test', true, [like('newer')])
    expect(cache.get('leaf.test')?.chain[0]?.subject.commonName).toBe('newer')
  })

  it('upgrades what an unaccepted connection left once an accepted one presents the same certificate, and not the other way', () => {
    const cache = new CertificateCache()
    const leaf = like('leaf')
    noteInto(cache, 'a.test', false, [leaf])
    expect(cache.trustedOf('a.test')).toBe(false)
    noteInto(cache, 'a.test', true, [leaf])
    expect(cache.trustedOf('a.test')).toBe(true)
    noteInto(cache, 'a.test', false, [like('other')])
    expect(cache.get('a.test')?.chain[0]?.subject.commonName).toBe('leaf')
  })

  it('takes the first certificate that can be read', () => {
    const cache = new CertificateCache()
    noteInto(cache, 'a.test', true, [{} as never, null, like('second')])
    expect(cache.get('a.test')?.chain[0]?.subject.commonName).toBe('second')
  })

  it('never throws into the verify proc', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const cache = new CertificateCache()
    for (const bad of [null, undefined, {}, { data: 5 }, { data: 'x', issuer: null }]) expect(() => { noteInto(cache, 'a.test', true, [bad as never]) }).not.toThrow()
    log.mockRestore()
  })
})

describe('when the viewer may open', () => {
  const window = (url: string, active = 't1'): { tabs: { getState: () => unknown }, overlays: { show: ReturnType<typeof vi.fn> } } => ({
    tabs: { getState: () => ({ activeTabId: active, tabs: [{ id: 't1', url }] }) },
    overlays: { show: vi.fn() }
  })

  it('reads the host of an https address only', () => {
    expect(httpsHostOf('https://Example.com:8443/a')).toBe('example.com')
    expect(httpsHostOf('https://[::1]/')).toBe('::1')
    for (const url of ['http://example.com/', 'orivon://settings', 'file:///x', 'ipfs://bafy', '', 'nonsense']) expect(httpsHostOf(url), url).toBeUndefined()
  })

  it('names the https hosts of every tab of every window, lower-case', () => {
    const open = (...urls: string[]): never => ({ tabs: { getState: () => ({ tabs: urls.map((url, index) => ({ id: `t${String(index)}`, url })) }) } }) as never
    expect([...hostsOfTabs([open('https://A.test/x', 'http://plain.test/'), open('https://b.test:8443/', 'orivon://settings')])].sort()).toEqual(['a.test', 'b.test'])
  })

  it('opens for the tab in front when it is https, and for nothing else', () => {
    const secure = window('https://example.com/')
    openCertificate(secure as never)
    expect(secure.overlays.show).toHaveBeenCalledWith('certificate')
    expect(certificateAvailable(secure as never)).toBe(true)
    const plain = window('http://example.com/')
    openCertificate(plain as never)
    expect(plain.overlays.show).not.toHaveBeenCalled()
    expect(activeHttpsHost(window('https://a.test/', 'none') as never)).toBeUndefined()
  })
})

describe('the certificate overlay', () => {
  function setup (url = 'https://leaf.test/', writeClipboard: (text: string) => void = () => undefined): { handler: OverlayHandler, cache: CertificateCache, close: ReturnType<typeof vi.fn>, reload: ReturnType<typeof vi.fn>, leaf: CertificateLike } {
    const cache = new CertificateCache()
    const leaf = like('leaf')
    noteInto(cache, 'leaf.test', true, [leaf])
    const reload = vi.fn()
    const close = vi.fn()
    const window = { tabs: { getState: () => ({ activeTabId: 't1', tabs: [{ id: 't1', url }] }), reload } }
    const handler = certificateOverlayFor({ cache, writeClipboard }).attach({ window, services: {}, send: vi.fn(), close } as unknown as OverlayWindow)
    return { handler, cache, close, reload, leaf }
  }

  it('is a centred popup with the popup dismissals', () => {
    const def = certificateOverlayFor({ cache: new CertificateCache(), writeClipboard: vi.fn() })
    expect(def).toMatchObject({ name: 'certificate', placement: { kind: 'area', at: 'center', width: 520 }, focus: 'take', layer: 'popup', keep: 'fresh', height: { max: 460 } })
    expect(def.closeOn).toEqual({ blur: true, tabSwitch: true, navigation: false, layout: false })
  })

  it('shows the chain the active tab\'s host presented, whatever payload the chrome sent', () => {
    const s = setup()
    const page = s.handler.show?.({ host: 'evil.test' }) as CertificatePage
    expect(page.host).toBe('leaf.test')
    expect(page.chain?.[0]?.subject.commonName).toBe('leaf')
  })

  it('says there is no certificate yet for a host nothing has presented one for', () => {
    const s = setup('https://unseen.test/')
    expect(s.handler.show?.(undefined)).toEqual({ host: 'unseen.test', chain: null })
  })

  it('shows nothing on a page that was not delivered over https', () => {
    expect(setup('http://leaf.test/').handler.show?.(undefined)).toBeUndefined()
  })

  it('copies the PEM of a certificate of the chain it showed, and nothing else', async () => {
    const written: string[] = []
    const s = setup('https://leaf.test/', (text) => { written.push(text) })
    await expect(s.handler.request({ type: 'copyPem', index: 0 })).resolves.toEqual({ ok: false })
    s.handler.show?.(undefined)
    await expect(s.handler.request({ type: 'copyPem', index: 0 })).resolves.toEqual({ ok: true })
    expect(written).toEqual([s.leaf.data])
    for (const index of [1, -1, 99]) await expect(s.handler.request({ type: 'copyPem', index })).resolves.toEqual({ ok: false })
  })

  it('reports a clipboard that throws', async () => {
    const s = setup('https://leaf.test/', () => { throw new Error('none') })
    s.handler.show?.(undefined)
    await expect(s.handler.request({ type: 'copyPem', index: 0 })).resolves.toEqual({ ok: false })
  })

  it('refuses every other command and extra fields', async () => {
    const s = setup()
    s.handler.show?.(undefined)
    for (const bad of [undefined, null, 'reload', {}, { type: 'open' }, { type: 'reload' }, { type: 'reload', index: 0 }, { type: 'copyPem' }, { type: 'copyPem', index: '0' }, { type: 'copyPem', index: 0, pem: 'x' }]) {
      expect(await s.handler.request(bad), JSON.stringify(bad)).toBeUndefined()
    }
    expect(s.reload).not.toHaveBeenCalled()
  })
})
