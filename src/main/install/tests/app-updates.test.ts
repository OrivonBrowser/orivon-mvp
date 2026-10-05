import { describe, expect, it, vi } from 'vitest'
import { APP } from '../../../broker/transport/tests/ipc.test-helpers.js'
import type { LoadResult, LoadUpdateAvailable } from '../../../loader/index.js'
import type { ProviderVerdict } from '../../../trust/score-provider.js'
import type { PinRecord } from '../../../broker/policy/pin.js'
import { createAppUpdates } from '../app-updates.js'
import type { AppUpdatesDeps, UpdatePrompts } from '../app-updates.js'
import { fakeBroker, fakeLoader, grant, installedResult, manifestWith, manifestWithCapabilities } from './app-install.test-helpers.js'

// An installed app's name moved: the offer is judged verified or not, the
// person is asked, and only a yes (or a confirmed Trust & Force) fetches and
// installs it. Every tab on the origin then reloads.

const FROM = 'bafybeiczdb3ssfsyyhhgvxwrkkqndv45umiz6vov46l4hvxukyolejbcgi'
const TO = 'bafybeifnx3u22ngv4ygpnj32qkwzrpgizw4i7e3swp4v6am5piiih3ude4'
const LATER = 'bafybeibwzifw52ttrkqlikfzext5akxu7lz4xiwjgwzmqcpdzmp3n5vnbe'
const HOST = 'app.example'

const PIN: PinRecord = { schema: 1, origin: APP, bundleHash: 'sha256:' + 'a'.repeat(64), assets: [], version: '1.0.0', pinnedAt: 0, content: { cid: FROM, via: 'ipfs', pointersVerified: true } }

function judged (level: number): ProviderVerdict {
  return { status: 'judged', provider: { name: 'P', address: 'x' }, evaluation: { id: 'cid:x', name: 'App', version: undefined, evaluated: '2026-10-05', trustlessity: { level, privacy: false }, summary: undefined, operations: [], connections: [], evidence: [] } }
}

function available (overrides: Partial<LoadUpdateAvailable> = {}): LoadUpdateAvailable {
  return { outcome: 'update-available', canonicalOrigin: APP, fromCid: FROM, toCid: TO, manifest: { ...manifestWith('1.0.1'), domain: HOST }, pointersVerified: true, ...overrides }
}

interface Rig {
  readonly updates: ReturnType<typeof createAppUpdates>
  readonly prompts: { [K in keyof UpdatePrompts]: ReturnType<typeof vi.fn> }
  readonly loader: ReturnType<typeof fakeLoader>
  readonly reloaded: string[]
  readonly changes: number[]
  readonly capabilityPrompt: ReturnType<typeof vi.fn>
}

function rig (options: {
  verdict?: ProviderVerdict
  applied?: LoadResult
  quiet?: ReadonlyArray<{ cid: string, verified: boolean }>
  verified?: Partial<{ yes: boolean, quiet: boolean }> | null
  notice?: Partial<{ quiet: boolean }> | null
  force?: boolean
  persist?: boolean
  floor?: string | undefined
} = {}): Rig {
  const manifest = { ...manifestWith('1.0.1'), domain: HOST }
  const loader = fakeLoader({ outcome: 'rejected', reason: 'unused' }, {
    pinFor: async () => PIN,
    applyUpdate: async () => options.applied ?? { outcome: 'needs-reconsent', canonicalOrigin: APP, manifest, tree: { root: 'sha256:' + 'b'.repeat(64), assets: [] }, entries: [], declaration: undefined, content: { cid: TO, via: 'ipfs', pointersVerified: true } },
    installFetched: async () => installedResult(manifest) as never,
    quietOffers: async () => ({ quiet: options.quiet ?? [] })
  })
  loader.installFetched.mockResolvedValue(installedResult(manifest))
  const prompts = {
    verified: vi.fn(async () => options.verified === null ? null : { yes: false, quiet: false, ...options.verified }),
    notice: vi.fn(async () => options.notice === null ? null : { quiet: false, ...options.notice }),
    confirmForce: vi.fn(async () => options.force ?? false),
    failed: vi.fn(async () => {})
  }
  const reloaded: string[] = []
  const changes: number[] = []
  const capabilityPrompt = vi.fn(async () => true)
  const deps: AppUpdatesDeps = {
    outcome: { broker: fakeBroker({ versionFloor: options.floor ?? '1.0.0', grants: [grant()] }), loader, capabilityPrompt },
    verdictFor: async () => options.verdict ?? judged(3),
    prompts,
    reloadTabs: (origin) => { reloaded.push(origin) },
    persistQuiet: options.persist ?? true
  }
  const updates = createAppUpdates(deps)
  updates.onChange(() => { changes.push(changes.length) })
  return { updates, prompts, loader, reloaded, changes, capabilityPrompt }
}

describe('a verified update', () => {
  it('asks, and Yes installs it, reloads every tab on the origin and clears the offer', async () => {
    const r = rig({ verified: { yes: true } })
    await r.updates.offered(available())
    expect(r.prompts.verified).toHaveBeenCalledTimes(1)
    expect(r.loader.applyUpdate).toHaveBeenCalledWith(APP, TO, expect.anything())
    expect(r.loader.installFetched).toHaveBeenCalledTimes(1)
    expect(r.reloaded).toEqual([APP])
    expect(r.updates.pending(APP)).toBeUndefined()
    expect(r.changes.length).toBeGreaterThan(0)
  })

  it('reports the offer as verified, with its versions and level', async () => {
    const r = rig()
    await r.updates.offered(available())
    expect(r.updates.pending(APP)).toMatchObject({ toCid: TO, fromVersion: '1.0.0', toVersion: '1.0.1', verified: true, level: 3 })
  })

  it('Not now keeps the offer, applies nothing, and is not asked again this run', async () => {
    const r = rig({ verified: { yes: false } })
    await r.updates.offered(available())
    await r.updates.offered(available())
    expect(r.prompts.verified).toHaveBeenCalledTimes(1)
    expect(r.loader.applyUpdate).not.toHaveBeenCalled()
    expect(r.updates.pending(APP)).toBeDefined()
  })

  it('still asks about a capability the update widens', async () => {
    const widened = { ...manifestWithCapabilities('1.0.1'), domain: HOST }
    const r = rig({
      verified: { yes: true },
      applied: { outcome: 'needs-capability-prompt', canonicalOrigin: APP, manifest: widened, tree: { root: 'sha256:' + 'b'.repeat(64), assets: [] }, entries: [], declaration: undefined, content: undefined, requestedPatterns: { 'tcp.connect': ['api.example.com:443'] } }
    })
    r.loader.installFetched.mockResolvedValue(installedResult(widened))
    await r.updates.offered(available({ manifest: widened }))
    expect(r.capabilityPrompt).toHaveBeenCalledTimes(1)
  })

  it('keeps the offer when the tab left, and asks again on the next visit', async () => {
    const r = rig({ verified: null })
    await r.updates.offered(available())
    await r.updates.offered(available())
    expect(r.prompts.verified).toHaveBeenCalledTimes(2)
    expect(r.loader.keepQuiet).not.toHaveBeenCalled()
    expect(r.updates.pending(APP)).toBeDefined()
  })

  it('keeps the offer and says why when the download failed', async () => {
    const r = rig({ verified: { yes: true }, applied: { outcome: 'rejected', reason: 'the gateway did not answer' } })
    await r.updates.offered(available())
    expect(r.prompts.failed).toHaveBeenCalledWith(expect.objectContaining({ origin: APP }), 'the gateway did not answer', undefined)
    expect(r.updates.pending(APP)).toBeDefined()
    expect(r.reloaded).toEqual([])
  })

  it('drops the offer when the name moved again, since a later check makes a fresh one', async () => {
    const r = rig({ verified: { yes: true }, applied: { outcome: 'rejected', reason: 'moved again', movedAgain: true } })
    await r.updates.offered(available())
    expect(r.updates.pending(APP)).toBeUndefined()
  })

  it('records the tick against the verified question when the person says Not now', async () => {
    const r = rig({ verified: { yes: false, quiet: true } })
    await r.updates.offered(available())
    expect(r.loader.keepQuiet).toHaveBeenCalledWith(APP, { cid: TO, verified: true })
  })

  it('is not asked about at all after a tick in an earlier run, and the key still has the offer', async () => {
    const r = rig({ quiet: [{ cid: TO, verified: true }] })
    await r.updates.offered(available())
    expect(r.prompts.verified).not.toHaveBeenCalled()
    expect(r.updates.pending(APP)).toBeDefined()
  })

  it('keeps a tick in memory only in a private session', async () => {
    const r = rig({ verified: { yes: false, quiet: true }, persist: false })
    await r.updates.offered(available())
    expect(r.loader.keepQuiet).not.toHaveBeenCalled()
    await r.updates.offered(available())
    expect(r.prompts.verified).toHaveBeenCalledTimes(1)
  })
})

describe('an update that is not verified', () => {
  it('only tells the person, with the reason, and never applies', async () => {
    const r = rig({ verdict: { status: 'no-score', provider: { name: 'P', address: 'x' } } })
    await r.updates.offered(available())
    expect(r.prompts.verified).not.toHaveBeenCalled()
    expect(r.prompts.notice).toHaveBeenCalledWith(expect.objectContaining({ verified: false, reasons: ['no-score'] }), undefined)
    expect(r.loader.applyUpdate).not.toHaveBeenCalled()
  })

  it.each([
    ['a version no newer than the floor', { floor: '1.0.1' }, 'not-newer'],
    ['a manifest naming another domain', { offer: { manifest: { ...manifestWith('1.0.1'), domain: 'other.example' } } }, 'other-home'],
    ['a name proven only through DNS', { offer: { pointersVerified: false } }, 'unproven-name']
  ] as const)('is a notice for %s', async (_label, setup, reason) => {
    const r = rig({ floor: 'floor' in setup ? setup.floor : undefined })
    await r.updates.offered(available('offer' in setup ? setup.offer : {}))
    expect(r.prompts.notice).toHaveBeenCalledWith(expect.objectContaining({ reasons: [reason] }), undefined)
    expect(r.prompts.verified).not.toHaveBeenCalled()
  })

  it('a tick on the notice never silences the question the same CID becomes once it is verified', async () => {
    const quiet = rig({ verdict: { status: 'off' }, notice: { quiet: true } })
    await quiet.updates.offered(available())
    expect(quiet.loader.keepQuiet).toHaveBeenCalledWith(APP, { cid: TO, verified: false })
    const later = rig({ quiet: [{ cid: TO, verified: false }] })
    await later.updates.offered(available())
    expect(later.prompts.verified).toHaveBeenCalledTimes(1)
  })

  it('applies only through Trust & Force, and only after the confirmation, which lists what carries over', async () => {
    const r = rig({ verdict: { status: 'off' }, force: true })
    await r.updates.offered(available())
    expect(await r.updates.apply(APP, TO)).toEqual({ ok: true })
    expect(r.prompts.confirmForce).toHaveBeenCalledWith(expect.objectContaining({ toCid: TO }), expect.arrayContaining([expect.stringMatching(/api\.example\.com/)]), undefined)
    expect(r.reloaded).toEqual([APP])
  })

  it('does nothing when the person does not confirm Trust & Force', async () => {
    const r = rig({ verdict: { status: 'off' }, force: false })
    await r.updates.offered(available())
    expect(await r.updates.apply(APP, TO)).toEqual({ ok: false, reason: 'declined' })
    expect(r.loader.applyUpdate).not.toHaveBeenCalled()
    expect(r.updates.pending(APP)).toBeDefined()
  })
})

describe('a question left open', () => {
  it('does not hold the origin\'s queue: the key\'s apply goes through while the question waits', async () => {
    const r = rig({ verified: { yes: false } })
    r.prompts.verified.mockImplementation(async () => await new Promise(() => {}))
    void r.updates.offered(available())
    await vi.waitFor(() => { expect(r.prompts.verified).toHaveBeenCalledTimes(1) })
    expect(await r.updates.apply(APP, TO)).toEqual({ ok: true })
    expect(r.reloaded).toEqual([APP])
  })

  it('is not asked a second time by a check that finds the same move meanwhile', async () => {
    const r = rig()
    r.prompts.verified.mockImplementation(async () => await new Promise(() => {}))
    void r.updates.offered(available())
    await vi.waitFor(() => { expect(r.prompts.verified).toHaveBeenCalledTimes(1) })
    await r.updates.offered(available())
    expect(r.prompts.verified).toHaveBeenCalledTimes(1)
  })

  it('may be answered Yes while the task that started it still holds the queue', async () => {
    const { outsideOriginQueue, withOriginQueue } = await import('../origin-queue.js')
    const r = rig({ verified: { yes: true } })
    let started: Promise<void> | undefined
    await withOriginQueue(APP, async () => { started = outsideOriginQueue(async () => { await r.updates.offered(available()) }) })
    await started
    expect(r.reloaded).toEqual([APP])
  })
})

describe('a name that returns to the pinned content', () => {
  it('withdraws the offer, and says so to the key', async () => {
    const r = rig()
    await r.updates.offered(available())
    expect(r.updates.pending(APP)).toBeDefined()
    const before = r.changes.length
    r.updates.withdraw(APP)
    expect(r.updates.pending(APP)).toBeUndefined()
    expect(r.changes.length).toBe(before + 1)
    r.updates.withdraw(APP)
    expect(r.changes.length).toBe(before + 1)
  })
})

describe('apply', () => {
  it('refuses a CID that is not the pending offer', async () => {
    const r = rig({ verdict: { status: 'off' }, force: true })
    await r.updates.offered(available())
    expect(await r.updates.apply(APP, LATER)).toEqual({ ok: false, reason: 'no such offer' })
    expect(await r.updates.apply('https://elsewhere.example', TO)).toEqual({ ok: false, reason: 'no such offer' })
    expect(r.loader.applyUpdate).not.toHaveBeenCalled()
  })

  it('applies a verified offer from the key without a second question', async () => {
    const r = rig({ verified: { yes: false } })
    await r.updates.offered(available())
    expect(await r.updates.apply(APP, TO)).toEqual({ ok: true })
    expect(r.prompts.confirmForce).not.toHaveBeenCalled()
    expect(r.reloaded).toEqual([APP])
  })
})
