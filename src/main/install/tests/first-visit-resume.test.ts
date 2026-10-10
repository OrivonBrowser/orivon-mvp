import { describe, expect, it, vi } from 'vitest'
import type { Manifest } from '../../../contracts/index.js'
import type { FirstManifest, PendingConsent } from '../../../loader/index.js'
import type { LiveHooks } from '../../../loader/serve/live-serve.js'
import { createFirstVisit, runFirstVisit } from '../first-visit.js'
import { VERIFIED, WEBSITE, leaf, MANIFEST, DECLARED, readOf, bundle, harness, present, depsOf, run, LATE, settled, grantsOf } from './first-visit.test-helpers.js'
import type { Harness } from './first-visit.test-helpers.js'

// An app that was allowed and is not yet pinned: its consent is kept, and it is served again, checked, after a restart.

describe('an app that was allowed and is not yet pinned', () => {
  it('keeps the consent for a restart once the app is served, registered and granted, and before the tab goes in', async () => {
    const h = harness()
    const result = await run(h, present, undefined, LATE)
    expect(h.events.indexOf('serve-live')).toBeLessThan(h.events.indexOf('remember'))
    expect(h.events.indexOf('remember')).toBeLessThan(h.events.indexOf('enter'))
    expect(vi.mocked(h.loader.rememberConsent).mock.calls[0]?.[1]).toBe(DECLARED.declaration)
    expect(await grantsOf(h)).toEqual(['fs'])
    h.badData()?.({ differing: ['/app.js'] })
    await settled(result)
  })

  describe('a new version of the app', () => {
    const NEXT_CONTENT = { cid: 'bafynext', via: 'ipns-key' as const, pointersVerified: true }
    const NEXT_TREE = { bundleHash: leaf('n'), leaves: [{ path: '/index.html', leaf: leaf('m') }] }
    const nextRead = (manifest: Manifest = MANIFEST): FirstManifest => ({ kind: 'app', canonicalOrigin: VERIFIED, manifest, bytes: new Uint8Array([2]), content: NEXT_CONTENT })
    const WIDER: Manifest = { ...MANIFEST, version: '1.1.0', capabilities: { fs: { quotaBytes: 1024 }, net: { tcp: { connect: ['a.example:443'] } } } }

    /** The app is allowed at the first read, and a later read shows the next version. */
    function moving (next: FirstManifest = nextRead(), extra: Parameters<typeof harness>[0] = {}): Harness {
      return harness({ reads: [readOf(VERIFIED), next], declarations: [DECLARED, { kind: 'declared', declaration: NEXT_TREE }], ...extra })
    }

    const asNext = async (h: Harness, served: Manifest = MANIFEST): Promise<Awaited<ReturnType<NonNullable<LiveHooks['fresh']>>>> => await h.hooks()?.fresh?.({ manifest: served, declaration: DECLARED.declaration, content: undefined })

    it('is followed, not blocked: the live check and the download move to it, no grant or registration is lost, no warning is shown', async () => {
      const h = moving(undefined, { bundles: [bundle(VERIFIED, { content: NEXT_CONTENT, declaration: NEXT_TREE, tree: { root: NEXT_TREE.bundleHash, assets: [{ path: '/index.html', leaf: leaf('m') }] } })] })
      const result = await run(h, present, undefined, LATE)
      const next = await asNext(h)
      expect(next).toMatchObject({ content: 'bafynext', declaration: NEXT_TREE })
      await h.hooks()?.adopt?.(next as NonNullable<typeof next>)
      expect(h.blocked).not.toHaveBeenCalled()
      expect(h.loader.endLive).not.toHaveBeenCalled()
      expect(h.host.sheets).toEqual([])
      expect(h.broker.app.isRegisteredSync(h.origin)).toBe(true)
      expect(await grantsOf(h)).toEqual(['fs'])
      expect(vi.mocked(h.loader.rememberConsent).mock.calls.at(-1)?.[1]).toBe(NEXT_TREE)
      expect(await settled(result)).toBe('pinned')
      expect(vi.mocked(h.loader.fetchForInstall).mock.calls[0]?.[0]).toMatchObject({ content: NEXT_CONTENT })
    })

    it('is the same as the one being served when nothing moved: the handler is told so, and a mismatch stays bad data', async () => {
      const h = harness({ reads: [readOf(VERIFIED)], declarations: [DECLARED] })
      const result = await run(h, present, undefined, LATE)
      expect(await asNext(h)).toBeUndefined()
      h.badData()?.({ differing: ['/app.js'] })
      expect(await settled(result)).toBe('blocked')
      expect(h.blocked).toHaveBeenCalled()
    })

    it('is not followed when its manifest contradicts its own tree, or its tree cannot be read', async () => {
      for (const declaration of [{ kind: 'mismatch' as const, differing: ['/.well-known/orivon.json'] }, { kind: 'failed' as const, reason: 'HTTP 503' }]) {
        const h = harness({ reads: [readOf(VERIFIED), nextRead()], declarations: [DECLARED, declaration] })
        const result = await run(h, present, undefined, LATE)
        expect(await asNext(h)).toBeUndefined()
        h.badData()?.({ differing: ['/x'] })
        await settled(result)
      }
    })

    /** The manifest the person allowed, then a new version that widens it in one way; what the first holds is granted. */
    const widenings: Array<{ name: string, before: Manifest, after: Manifest, grants: string[] }> = [
      { name: 'a new capability kind', before: MANIFEST, after: WIDER, grants: ['fs'] },
      { name: 'a wider pattern inside a kind that is held', before: { ...MANIFEST, capabilities: { net: { tcp: { connect: ['a.example:443'] } } } }, after: { ...MANIFEST, version: '1.1.0', capabilities: { net: { tcp: { connect: ['*:*'] } } } }, grants: ['tcp.connect'] },
      { name: 'more concurrent sockets', before: { ...MANIFEST, capabilities: { net: { tcp: { connect: ['a.example:443'] }, concurrentSockets: 4 } } }, after: { ...MANIFEST, version: '1.1.0', capabilities: { net: { tcp: { connect: ['a.example:443'] }, concurrentSockets: 64 } } }, grants: ['tcp.connect'] },
      { name: 'a bigger storage quota', before: { ...MANIFEST, capabilities: { fs: { quotaBytes: 1024 } } }, after: { ...MANIFEST, version: '1.1.0', capabilities: { fs: { quotaBytes: 1_048_576 } } }, grants: ['fs'] },
      { name: 'more identity curves', before: { ...MANIFEST, capabilities: { id: { curves: ['secp256k1'] } } }, after: { ...MANIFEST, version: '1.1.0', capabilities: { id: { curves: ['secp256k1', 'ed25519'] } } }, grants: ['id'] }
    ]

    for (const widening of widenings) {
      it(`keeps serving the allowed version, registers nothing, until the person answers the question, for ${widening.name}`, async () => {
        const h = harness({ reads: [{ ...readOf(VERIFIED), manifest: widening.before } as FirstManifest, nextRead(widening.after)], declarations: [DECLARED, { kind: 'declared', declaration: NEXT_TREE }] })
        let answer = (_value: boolean): void => {}
        h.answerWidening.current = async () => await new Promise<boolean>((resolve) => { answer = resolve })
        const result = await run(h, present, undefined, LATE)
        const next = await asNext(h, widening.before)
        const adopting = h.hooks()?.adopt?.(next as NonNullable<typeof next>)
        await vi.waitFor(() => { expect(h.capabilityPrompt).toHaveBeenCalledTimes(1) })
        // The question is open: the new manifest is not registered, the consent is not kept for it, nothing is granted.
        expect((await h.broker.app.manifest(h.origin)).version).toBe(widening.before.version)
        expect(vi.mocked(h.loader.rememberConsent).mock.calls.every((call) => call[1] === DECLARED.declaration)).toBe(true)
        expect(h.capabilityPrompt.mock.calls[0]?.[1]).toBe(widening.after)
        answer(true)
        await adopting
        expect((await h.broker.app.manifest(h.origin)).version).toBe(widening.after.version)
        expect(vi.mocked(h.loader.rememberConsent).mock.calls.at(-1)?.[1]).toBe(NEXT_TREE)
        h.hooks()?.onBadData({ differing: [] })
        await settled(result)
      })

      it(`stays on the allowed version, and does not ask again, when the person declines, for ${widening.name}`, async () => {
        const h = harness({ reads: [{ ...readOf(VERIFIED), manifest: widening.before } as FirstManifest, nextRead(widening.after)], declarations: [DECLARED, { kind: 'declared', declaration: NEXT_TREE }] })
        h.answerWidening.current = false
        const result = await run(h, present, undefined, LATE)
        const next = await asNext(h, widening.before)
        await expect(h.hooks()?.adopt?.(next as NonNullable<typeof next>)).rejects.toThrow(/kept the current version/)
        await expect(h.hooks()?.adopt?.(next as NonNullable<typeof next>)).rejects.toThrow(/kept the current version/)
        expect(h.capabilityPrompt).toHaveBeenCalledTimes(1)
        expect((await h.broker.app.manifest(h.origin)).version).toBe(widening.before.version)
        expect(h.blocked).not.toHaveBeenCalled()
        expect(h.loader.endLive).not.toHaveBeenCalled()
        expect(await grantsOf(h)).toEqual(expect.arrayContaining(widening.grants))
        h.hooks()?.onBadData({ differing: [] })
        await settled(result)
      })
    }

    it('grants what the person accepted of a widened version, and asks nothing for a version that widens nothing', async () => {
      const wider = moving(nextRead(WIDER))
      const result = await run(wider, present, undefined, LATE)
      const next = await asNext(wider)
      await wider.hooks()?.adopt?.(next as NonNullable<typeof next>)
      expect(wider.capabilityPrompt).toHaveBeenCalledTimes(1)
      expect(await grantsOf(wider)).toEqual(expect.arrayContaining(['fs', 'tcp.connect']))
      wider.hooks()?.onBadData({ differing: [] })
      await settled(result)

      const same = moving()
      const second = await run(same, present, undefined, LATE)
      await same.hooks()?.adopt?.((await asNext(same)) as NonNullable<Awaited<ReturnType<typeof asNext>>>)
      expect(same.capabilityPrompt).not.toHaveBeenCalled()
      expect(same.consent).toHaveBeenCalledTimes(1)
      same.hooks()?.onBadData({ differing: [] })
      await settled(second)
    })

    it('treats a widened version as declined when no question is wired, rather than registering it unasked', async () => {
      const h = harness({ reads: [readOf(VERIFIED), nextRead(WIDER)], declarations: [DECLARED, { kind: 'declared', declaration: NEXT_TREE }] })
      const result = await runFirstVisit({ ...depsOf(h), capabilityPrompt: undefined, backgroundDelayMs: LATE }, h.origin, h.url, present, h.host)
      const next = await asNext(h)
      await expect(h.hooks()?.adopt?.(next as NonNullable<typeof next>)).rejects.toThrow()
      expect((await h.broker.app.manifest(h.origin)).version).toBe('1.0.0')
      h.hooks()?.onBadData({ differing: [] })
      if (result.outcome === 'entered') await result.background
    })

    it('is found by the download when the name moved under it, and pinned instead of the one that was allowed', async () => {
      const h = moving(undefined, { bundles: [{ ok: false, reason: 'HTTP 409', moved: true }, bundle(VERIFIED, { content: NEXT_CONTENT, declaration: NEXT_TREE, tree: { root: NEXT_TREE.bundleHash, assets: [{ path: '/index.html', leaf: leaf('m') }] } })] })
      expect(await settled(await run(h))).toBe('pinned')
      expect(h.blocked).not.toHaveBeenCalled()
      expect(h.loader.endLive).not.toHaveBeenCalled()
      expect(vi.mocked(h.loader.fetchForInstall).mock.calls[1]?.[0]).toMatchObject({ content: NEXT_CONTENT })
      expect(h.broker.app.isRegisteredSync(h.origin)).toBe(true)
      expect(await grantsOf(h)).toEqual(['fs'])
    })

    it('is found by the download when whole files match their own tree but not the allowed one: that is a deploy, not tampering', async () => {
      const deployed = bundle(WEBSITE, { declaration: NEXT_TREE, tree: { root: NEXT_TREE.bundleHash, assets: [{ path: '/index.html', leaf: leaf('m') }] } })
      const h = harness({ origin: WEBSITE, reads: [readOf(WEBSITE), { ...nextRead(), canonicalOrigin: WEBSITE, content: undefined } as FirstManifest], declarations: [DECLARED, { kind: 'declared', declaration: NEXT_TREE }], bundles: [deployed, deployed] })
      expect(await settled(await run(h))).toBe('pinned')
      expect(h.blocked).not.toHaveBeenCalled()
      expect(h.broker.app.isRegisteredSync(WEBSITE)).toBe(true)
    })

    it('stays unfinished, quietly, when no newer version can be read: nothing is forgotten', async () => {
      const h = harness({ bundles: [{ ok: false, reason: 'HTTP 409', moved: true }, { ok: false, reason: 'HTTP 409', moved: true }], reads: [readOf(VERIFIED)] })
      expect(await settled(await run(h))).toBe('unfinished')
      expect(h.blocked).not.toHaveBeenCalled()
      expect(h.loader.endLive).not.toHaveBeenCalled()
      expect(await grantsOf(h)).toEqual(['fs'])
    })
  })

  it('is served again after a restart as it was allowed, never asked about again, and pins that root once it is used', async () => {
    const pending: PendingConsent = { read: readOf(VERIFIED) as PendingConsent['read'], declaration: DECLARED.declaration }
    const h = harness({ pending: [pending], bundles: [bundle(VERIFIED)] })
    const visit = createFirstVisit({ deps: depsOf(h), untouched: () => false, servedFromCache: () => false })
    await visit.resume()
    expect(vi.mocked(h.loader.serveLive).mock.calls[0]?.[0]).toBe(pending.read)
    expect(vi.mocked(h.loader.serveLive).mock.calls[0]?.[1]).toBe(DECLARED.declaration)
    expect(h.broker.app.isRegisteredSync(h.origin)).toBe(true)
    expect(h.consent).not.toHaveBeenCalled()
    expect(h.events).not.toContain('enter')
    // A page's own hint must not start the old install path beside it.
    expect(await visit.kindOf(h.origin)).toBe('settling')
    expect(h.loader.fetchForInstall).not.toHaveBeenCalled()
    h.hooks()?.onServed?.()
    await vi.waitFor(() => { expect(h.loader.installFetched).toHaveBeenCalled() })
    expect(vi.mocked(h.loader.fetchForInstall).mock.calls[0]?.[0]).toBe(pending.read)
    await vi.waitFor(async () => { expect(await visit.kindOf(h.origin)).toBe('known') })
  })

  it('serves a resumed app, whose bad file blocks it like any other, and leaves what is registered alone', async () => {
    const pending: PendingConsent = { read: readOf(VERIFIED) as PendingConsent['read'], declaration: DECLARED.declaration }
    const h = harness({ pending: [pending] })
    const visit = createFirstVisit({ deps: depsOf(h), untouched: () => false, servedFromCache: () => false })
    await visit.resume()
    h.badData()?.({ differing: ['/app.js'] })
    await vi.waitFor(() => { expect(h.loader.endLive).toHaveBeenCalled() })
    expect(h.broker.app.isRegisteredSync(h.origin)).toBe(false)
    await vi.waitFor(() => { expect(h.blocked).toHaveBeenCalled() })
  })

  it('does not serve again an app that is already registered this run, or one that cannot be served', async () => {
    const pending: PendingConsent = { read: readOf(VERIFIED) as PendingConsent['read'], declaration: undefined }
    const registered = harness({ pending: [pending] })
    await registered.broker.registerApp(VERIFIED, MANIFEST)
    await createFirstVisit({ deps: depsOf(registered), untouched: () => false, servedFromCache: () => false }).resume()
    expect(registered.loader.serveLive).not.toHaveBeenCalled()
    const unable = harness({ pending: [pending], live: false })
    await createFirstVisit({ deps: depsOf(unable), untouched: () => false, servedFromCache: () => false }).resume()
    expect(unable.broker.app.isRegisteredSync(VERIFIED)).toBe(false)
  })
})

