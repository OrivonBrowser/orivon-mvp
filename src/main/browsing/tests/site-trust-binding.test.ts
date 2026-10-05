import { describe, expect, it } from 'vitest'
import type { Manifest } from '../../../contracts/index.js'
import type { PinRecord } from '../../../broker/policy/pin.js'
import type { ManifestAtRoot } from '../../../loader/fetch/manifest-at-root.js'
import type { ProviderVerdict } from '../../../trust/score-provider.js'
import { readHome } from '../site-home.js'
import type { HomeSource } from '../site-home.js'
import { buildSiteTrust, withProviderVerdict } from '../site-trust.js'
import type { NameEvidence } from '../../verifier/name-evidence.js'

// A judged level counts only at the domain the content's manifest names
// (ADR-0055): the content judged at app.eth shows its level at app.eth and
// shows the level this browser observed everywhere else.

const CID = 'bafybeiczdb3ssfsyyhhgvxwrkkqndv45umiz6vov46l4hvxukyolejbcgi'
const WAIT = 20

function manifest (domain: string | undefined): Manifest {
  return { orivonApiVersion: 0, id: 'app.test', name: 'App', version: '1.0.0', entry: 'index.html', capabilities: {}, ...(domain === undefined ? {} : { domain }) }
}

function source (read: ManifestAtRoot, pinned?: Manifest): HomeSource & { rootReads: number } {
  const home = { rootReads: 0, manifestFor: async () => pinned, manifestAt: async () => { home.rootReads += 1; return read } }
  return home
}

function judged (level: number): ProviderVerdict {
  return { status: 'judged', provider: { name: 'P', address: 'x' }, evaluation: { id: `cid:${CID}`, name: 'App', version: undefined, evaluated: '2026-10-05', trustlessity: { level, privacy: level === 4 }, summary: undefined, operations: [], connections: [], evidence: [] } }
}

function liveTrust (origin: string) {
  const name: NameEvidence = { line: 'n', rows: [], content: { source: 'live', cid: CID, pointersVerified: true }, nameProven: true }
  return buildSiteTrust(origin, null, false, undefined, undefined, 2_000, name)
}

const PIN = (origin: string): PinRecord => ({ schema: 1, origin, bundleHash: 'sha256:' + 'a'.repeat(64), assets: [], version: '1.0.0', pinnedAt: 10 })

async function levelAt (origin: string, read: ManifestAtRoot, verdict: ProviderVerdict = judged(4)): Promise<{ displayed: number, home: Awaited<ReturnType<typeof readHome>> }> {
  const trust = liveTrust(origin)
  const home = await readHome(source(read), origin, null, CID, verdict, WAIT)
  return { displayed: withProviderVerdict(trust, verdict, home).displayedLevel, home }
}

describe('a judged level at the domain the manifest names', () => {
  it('shows Level 4 where the live manifest names this host', async () => {
    const { displayed, home } = await levelAt('https://app.eth', { kind: 'app', bytes: new Uint8Array(), manifest: manifest('app.eth') })
    expect(displayed).toBe(4)
    expect(home).toMatchObject({ binding: 'bound', domain: 'app.eth' })
  })

  it('hides it at evil.eth, whose live manifest names app.eth, and keeps the observed level', async () => {
    const { displayed, home } = await levelAt('https://evil.eth', { kind: 'app', bytes: new Uint8Array(), manifest: manifest('app.eth') })
    expect(displayed).toBe(2)
    expect(home).toMatchObject({ binding: 'other-home', domain: 'app.eth' })
    const trust = withProviderVerdict(liveTrust('https://evil.eth'), judged(4), home)
    expect(trust).toMatchObject({ judgedShown: false, judgedElsewhere: true, homeDomain: 'app.eth' })
  })

  it('hides it for a manifest with no domain', async () => {
    expect((await levelAt('https://app.eth', { kind: 'app', bytes: new Uint8Array(), manifest: manifest(undefined) })).displayed).toBe(2)
  })

  it('hides it after a failed read, and says the read is not finished only when it did not answer in time', async () => {
    expect((await levelAt('https://app.eth', { kind: 'unread', reason: 'HTTP 502' })).displayed).toBe(2)
    const slow: HomeSource = { manifestFor: async () => undefined, manifestAt: async () => await new Promise<ManifestAtRoot>(() => {}) }
    const home = await readHome(slow, 'https://app.eth', null, CID, judged(4), WAIT)
    expect(home).toMatchObject({ binding: 'no-home', pending: true })
    expect(withProviderVerdict(liveTrust('https://app.eth'), judged(4), home)).toMatchObject({ displayedLevel: 2, homePending: true })
  })

  it('shows it after a verified 404: content with no manifest is a website, not an app', async () => {
    const { displayed, home } = await levelAt('https://site.eth', { kind: 'website' })
    expect(displayed).toBe(4)
    expect(home.binding).toBe('not-applicable')
  })

  it('reads the pin, not the network, for an installed app: no domain in the pin hides the level', async () => {
    const trust = buildSiteTrust('https://app.eth', PIN('https://app.eth'), true, undefined, undefined, 2_000)
    const src = source({ kind: 'website' }, manifest(undefined))
    const home = await readHome(src, 'https://app.eth', PIN('https://app.eth'), undefined, judged(3), WAIT)
    expect(home.binding).toBe('no-home')
    expect(src.rootReads).toBe(0)
    expect(withProviderVerdict(trust, judged(3), home).judgedShown).toBe(false)
    expect((await readHome(source({ kind: 'website' }, manifest('app.eth')), 'https://app.eth', PIN('https://app.eth'), undefined, judged(3), WAIT)).binding).toBe('bound')
  })

  it('treats a pin whose manifest cannot be read as no home', async () => {
    const home = await readHome(source({ kind: 'website' }), 'https://app.eth', PIN('https://app.eth'), undefined, judged(3), WAIT)
    expect(home.binding).toBe('no-home')
  })

  it('reads the live manifest only when a provider judged Level 3 or 4', async () => {
    for (const verdict of [{ status: 'off' }, { status: 'no-score', provider: { name: 'P', address: 'x' } }, judged(2)] as const) {
      const src = source({ kind: 'app', bytes: new Uint8Array(), manifest: manifest('app.eth') })
      await readHome(src, 'https://app.eth', null, CID, verdict, WAIT)
      expect(src.rootReads).toBe(0)
    }
    const src = source({ kind: 'app', bytes: new Uint8Array(), manifest: manifest('app.eth') })
    await readHome(src, 'https://app.eth', null, CID, judged(3), WAIT)
    expect(src.rootReads).toBe(1)
  })

  it('has nothing to bind for content with no CID', async () => {
    expect(await readHome(source({ kind: 'unread', reason: 'x' }), 'http://127.0.0.1:8875', null, undefined, judged(3), WAIT)).toMatchObject({ binding: 'not-applicable' })
  })
})
