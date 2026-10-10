import { describe, expect, it, vi } from 'vitest'
import type { Manifest } from '../../../contracts/index.js'
import type { FirstManifest } from '../../../loader/index.js'
import type { DialogCaller } from '../../consent/request-grant.js'
import { MANIFEST_PROBE_MS, runFirstVisit } from '../first-visit.js'
import { VERIFIED, MANIFEST, TREE, CONTENT, DECLARED, DIFFERENT, readOf, bundle, harness, TAB, present, depsOf, run, LATE, settled, grantsOf } from './first-visit.test-helpers.js'
import type { Harness } from './first-visit.test-helpers.js'


// The order of a first visit: the page is already on screen as an ordinary website; the person is asked as soon as
// the manifest is read, with the site's declared tree read and the whole app cached beside the question; Allow
// grants, pins what was staged and reloads the tab as the app, every file checked as it is served; Deny stops the
// caching. A mismatch anywhere is bad data: the page is stopped and the origin taken away.

describe('runFirstVisit, for an app a verifier serves', () => {
  it('caches the app from the moment its manifest is read, beside the question: the tree read, every file fetched, nothing granted, served or pinned', async () => {
    let answer = (_yes: boolean): void => {}
    const h = harness()
    h.consent.mockImplementation(async () => { h.events.push('ask'); await new Promise<boolean>((resolve) => { answer = resolve }); return true })
    const pending = runFirstVisit(depsOf(h, 0), h.origin, h.url, present, h.host)
    await vi.waitFor(() => { expect(h.consent).toHaveBeenCalled() })
    await vi.waitFor(() => { expect(h.loader.fetchForInstall).toHaveBeenCalled() })
    expect(h.loader.readDeclaration).toHaveBeenCalled()
    // The question is still open.
    expect(h.events).not.toContain('serve-live')
    expect(h.events).not.toContain('enter')
    expect(h.events).not.toContain('install')
    expect(h.broker.app.isRegisteredSync(h.origin)).toBe(false)
    expect(await grantsOf(h)).toEqual([])
    answer(true)
    const result = await pending
    expect(result.outcome).toBe('entered')
    await settled(result)
  })

  it('pins what caching staged when the answer is yes, before the tab reloads, so the reload is served from the pin', async () => {
    let answer = (_yes: boolean): void => {}
    const h = harness()
    h.consent.mockImplementation(async () => { h.events.push('ask'); await new Promise<boolean>((resolve) => { answer = resolve }); return true })
    const pending = runFirstVisit(depsOf(h, 0), h.origin, h.url, present, h.host)
    await vi.waitFor(() => { expect(h.loader.fetchForInstall).toHaveBeenCalled() })
    await new Promise((resolve) => setTimeout(resolve, 20))
    answer(true)
    const result = await pending
    expect(result.outcome).toBe('entered')
    expect(h.events.indexOf('serve-live')).toBeLessThan(h.events.indexOf('install'))
    expect(h.events.indexOf('install')).toBeLessThan(h.events.indexOf('enter'))
    expect(h.loader.fetchForInstall).toHaveBeenCalledTimes(1)
    expect(await settled(result)).toBe('pinned')
  })

  it('reloads the tab as the app at once when the answer comes before caching has ended, and pins when it ends', async () => {
    const h = harness()
    const result = await run(h, present, undefined, LATE)
    expect(h.events.indexOf('enter')).toBeGreaterThan(-1)
    expect(h.events).not.toContain('fetch')
    expect(await settled(result)).toBe('pinned')
    expect(h.events.slice(-2)).toEqual(['fetch', 'install'])
  })

  it('stops the caching, discards what it staged and pins nothing on a pressed Deny', async () => {
    let answer = (_yes: boolean): void => {}
    const staged = bundle(VERIFIED)
    const h = harness({ bundles: [staged] })
    h.consent.mockImplementation(async () => { h.events.push('ask'); return await new Promise<boolean>((resolve) => { answer = resolve }) })
    const pending = runFirstVisit(depsOf(h, 0), h.origin, h.url, present, h.host)
    await vi.waitFor(() => { expect(h.loader.fetchForInstall).toHaveBeenCalled() })
    await new Promise((resolve) => setTimeout(resolve, 20))
    answer(false)
    expect(await pending).toMatchObject({ outcome: 'plain', why: 'denied' })
    expect(staged.discard).toHaveBeenCalled()
    expect(h.loader.installFetched).not.toHaveBeenCalled()
    expect(h.declined.has(h.origin)).toBe(true)
    const signal = vi.mocked(h.loader.fetchForInstall).mock.calls[0]?.[2]
    expect(signal?.aborted).toBe(true)
  })

  it('stops the caching, with no record, when the tab leaves the origin without an answer', async () => {
    const staged = bundle(VERIFIED)
    const h = harness({ bundles: [staged], answer: 'dismissed' })
    const away = new AbortController()
    h.consent.mockImplementation(async () => { away.abort(); return 'dismissed' })
    const result = await runFirstVisit(depsOf(h, 0), h.origin, h.url, present, h.host, away.signal)
    expect(result.outcome).toBe('left')
    await vi.waitFor(() => { expect(staged.discard).toHaveBeenCalled() })
    expect(h.declined.has(h.origin)).toBe(false)
    expect(h.loader.installFetched).not.toHaveBeenCalled()
  })

  it('keeps the page running while it asks, and withdraws the question when the tab leaves the origin', async () => {
    const away = new AbortController()
    const h = harness()
    let asker: DialogCaller | undefined
    h.consent.mockImplementation(async (_origin, _manifest, _declared, _held, caller) => { asker = caller; return await new Promise<boolean>(() => {}) })
    void runFirstVisit(depsOf(h), h.origin, h.url, present, h.host, away.signal)
    await vi.waitFor(() => { expect(asker).toBeDefined() })
    expect(asker?.unheld).toBe(true)
    expect(asker?.signal?.aborted).toBe(false)
    away.abort()
    expect(asker?.signal?.aborted).toBe(true)
  })

  it('stops the page, with the warning and nothing granted, when caching finds a file that is not the declared one before the person has answered', async () => {
    let answer = (_yes: boolean): void => {}
    const mismatched = bundle(VERIFIED, { declaration: DIFFERENT, content: CONTENT })
    const h = harness({ bundles: [mismatched] })
    h.consent.mockImplementation(async () => { h.events.push('ask'); return await new Promise<boolean>((resolve) => { answer = resolve }) })
    const pending = runFirstVisit(depsOf(h, 0), h.origin, h.url, present, h.host)
    await vi.waitFor(() => { expect(h.blocked).toHaveBeenCalledTimes(1) })
    expect(h.blocked).toHaveBeenCalledWith(h.origin, expect.objectContaining({ kind: 'blocked', differing: ['/index.html'] }), undefined)
    expect(await grantsOf(h)).toEqual([])
    expect(h.loader.serveLive).not.toHaveBeenCalled()
    expect(h.loader.installFetched).not.toHaveBeenCalled()
    expect(mismatched.discard).toHaveBeenCalled()
    // The page being stopped ends the question; a late answer finds nothing to let in.
    answer(true)
    expect((await pending).outcome).toBe('left')
    expect(h.events).not.toContain('serve-live')
  })

  it('stops the page before the answer for content the verifier proved wrong, or a manifest its own tree contradicts', async () => {
    for (const declaration of [{ kind: 'failed' as const, reason: 'block does not hash to its CID', integrity: true as const }, { kind: 'mismatch' as const, differing: ['/.well-known/orivon.json'] }]) {
      const h = harness({ declarations: [declaration] })
      let asker: DialogCaller | undefined
      h.consent.mockImplementation(async (_origin, _manifest, _declared, _held, caller) => { h.events.push('ask'); asker = caller; return await new Promise<boolean>(() => {}) })
      void runFirstVisit(depsOf(h, 0), h.origin, h.url, present, h.host)
      await vi.waitFor(() => { expect(h.blocked).toHaveBeenCalledTimes(1) })
      expect(h.blocked.mock.calls[0]?.[1]).toMatchObject({ kind: 'blocked' })
      // The question about a stopped page is withdrawn, so the warning has the tab's panel to itself.
      expect(asker?.signal?.aborted).toBe(true)
      expect(await grantsOf(h)).toEqual([])
      expect(h.loader.serveLive).not.toHaveBeenCalled()
    }
  })

  it('does not hold the question for the declared tree', async () => {
    let release = (): void => {}
    const h = harness({ declarationGate: new Promise<void>((resolve) => { release = resolve }) })
    const answered = h.consent.mockImplementation(async () => { h.events.push('ask'); return true })
    const pending = run(h)
    await vi.waitFor(() => { expect(answered).toHaveBeenCalled() })
    expect(h.events).not.toContain('serve-live')
    release()
    await settled(await pending)
  })

  it('grants at once and enters at once: the app is served live, registered and granted before the tab goes in', async () => {
    const h = harness()
    const result = await run(h)
    expect(h.broker.app.isRegisteredSync(h.origin)).toBe(true)
    expect(await grantsOf(h)).toEqual(['fs'])
    expect(h.events.indexOf('serve-live')).toBeLessThan(h.events.indexOf('enter'))
    expect(h.grantsAt['serve-live']).toEqual([])
    expect(vi.mocked(h.loader.serveLive).mock.calls[0]?.[1]).toBe(DECLARED.declaration)
    await settled(result)
  })

  it('serves a site that declares nothing live all the same, on Orivon\'s own checks', async () => {
    const h = harness({ declarations: [{ kind: 'none' }] })
    const result = await run(h)
    expect(result.outcome).toBe('entered')
    expect(vi.mocked(h.loader.serveLive).mock.calls[0]?.[1]).toBeUndefined()
    await settled(result)
  })

  it('does not download an app another path already pinned', async () => {
    const h = harness()
    vi.mocked(h.loader.pinFor).mockResolvedValue({ schema: 1, origin: h.origin, bundleHash: TREE.root, assets: [], version: '1.0.0', pinnedAt: 0 })
    const result = await run(h)
    expect(await settled(result)).toBe('pinned')
    expect(h.loader.fetchForInstall).not.toHaveBeenCalled()
  })

  it('on files in the background that differ from the declaration blocks the app: grants and registration gone, nothing pinned, the tabs covered', async () => {
    const mismatched = bundle(VERIFIED, { declaration: DIFFERENT, content: CONTENT })
    const h = harness({ bundles: [mismatched] })
    const result = await run(h)
    expect(await settled(result)).toBe('blocked')
    expect(h.loader.installFetched).not.toHaveBeenCalled()
    expect(mismatched.discard).toHaveBeenCalled()
    expect(h.broker.app.isRegisteredSync(h.origin)).toBe(false)
    expect(await grantsOf(h)).toEqual([])
    expect(h.loader.endLive).toHaveBeenCalledWith(h.origin)
    expect(h.blocked).toHaveBeenCalledWith(h.origin, expect.objectContaining({ kind: 'blocked', name: 'Test App', differing: ['/index.html'] }), TAB)
  })

  it('treats a verification the verifier failed in the background as the same block', async () => {
    const h = harness({ bundles: [{ ok: false, reason: 'block does not hash to its CID', integrity: true }] })
    expect(await settled(await run(h))).toBe('blocked')
    expect(h.blocked).toHaveBeenCalledWith(h.origin, expect.objectContaining({ kind: 'blocked', invalid: 'block does not hash to its CID' }), TAB)
  })

  it('is silent about a background download that fails: nothing blocked, nothing shown, the grants stay for the next visit to finish', async () => {
    for (const failure of [{ reason: 'HTTP 404 (/app.js)' }, { reason: 'timed out' }, { reason: 'bad gateway', transient: true as const }, { reason: 'over its cap', tooLarge: true as const }]) {
      const h = harness({ bundles: [{ ok: false, ...failure }, { ok: false, ...failure }] })
      expect(await settled(await run(h)), failure.reason).toBe('unfinished')
      expect(h.blocked, failure.reason).not.toHaveBeenCalled()
      expect(h.host.sheets, failure.reason).toEqual([])
      expect(await grantsOf(h), failure.reason).toEqual(['fs'])
      expect(h.loader.endLive, failure.reason).not.toHaveBeenCalled()
    }
  })

  it('stays unfinished, and quiet, when the bundle could not be saved', async () => {
    const h = harness({ installed: 'rejected' })
    expect(await settled(await run(h))).toBe('unfinished')
    expect(h.blocked).not.toHaveBeenCalled()
    expect(await grantsOf(h)).toEqual(['fs'])
  })

  it('blocks when a served file turns out not to be the declared one, once, however many fail', async () => {
    const h = harness({ bundles: [bundle(VERIFIED)] })
    const result = await run(h, present, undefined, LATE)
    const report = h.badData()
    if (report === undefined) throw new Error('the loader was never told where to report')
    report({ differing: ['/app.js'] })
    report({ differing: ['/other.js'] })
    expect(await settled(result)).toBe('blocked')
    await vi.waitFor(() => { expect(h.loader.endLive).toHaveBeenCalledTimes(1) })
    expect(h.blocked).toHaveBeenCalledTimes(1)
    expect(h.blocked).toHaveBeenCalledWith(h.origin, expect.objectContaining({ kind: 'blocked', differing: ['/app.js'], differingCount: 1 }), TAB)
    expect(h.broker.app.isRegisteredSync(h.origin)).toBe(false)
    expect(await grantsOf(h)).toEqual([])
    expect(h.loader.installFetched).not.toHaveBeenCalled()
  })

  it('ends with no grant, registration, record or live handler, and the warning shown, when a block lands during any step of letting the app in', async () => {
    const bad = { differing: ['/app.js'] }
    const fire = (h: Harness): void => { h.hooks()?.onBadData(bad) }
    const steps: Array<[string, (h: Harness) => void, number]> = [
      ['serving', (h) => {
        vi.mocked(h.loader.serveLive).mockImplementationOnce(async (_read, _declaration, hooks) => { h.state.live = true; hooks.onBadData(bad); await new Promise((resolve) => setTimeout(resolve, 15)); return true })
      }, LATE],
      ['registering', (h) => {
        const original = h.broker.registerApp.bind(h.broker)
        vi.spyOn(h.broker, 'registerApp').mockImplementation(async (...args) => { fire(h); await new Promise((resolve) => setTimeout(resolve, 15)); return await original(...args) })
      }, LATE],
      ['granting', (h) => {
        const original = h.broker.clearDeclinedConsent.bind(h.broker)
        vi.spyOn(h.broker, 'clearDeclinedConsent').mockImplementation(async (...args) => { fire(h); await new Promise((resolve) => setTimeout(resolve, 15)); return await original(...args) })
      }, LATE],
      ['remembering', (h) => {
        vi.mocked(h.loader.rememberConsent).mockImplementationOnce(async () => { fire(h); await new Promise((resolve) => setTimeout(resolve, 15)); h.state.pending = true })
      }, LATE],
      ['pinning what was staged', (h) => {
        h.consent.mockImplementation(async () => { await vi.waitFor(() => { expect(h.loader.fetchForInstall).toHaveBeenCalled() }); await new Promise((resolve) => setTimeout(resolve, 20)); return true })
        vi.mocked(h.loader.installFetched).mockImplementationOnce(async (origin, manifest, tree) => {
          fire(h)
          await new Promise((resolve) => setTimeout(resolve, 15))
          return { outcome: 'installed' as const, canonicalOrigin: origin, manifest, pin: { schema: 1 as const, origin, bundleHash: tree.root, assets: [], version: manifest.version, pinnedAt: 0 } }
        })
      }, 0]
    ]
    for (const [step, arrange, delay] of steps) {
      const h = harness()
      arrange(h)
      const result = await run(h, present, undefined, delay)
      await vi.waitFor(() => { expect(h.loader.endLive, step).toHaveBeenCalled() })
      await vi.waitFor(() => { expect(h.blocked, step).toHaveBeenCalledTimes(1) })
      expect(result.outcome, step).not.toBe('failed')
      expect(await grantsOf(h), step).toEqual([])
      expect(h.broker.app.isRegisteredSync(h.origin), step).toBe(false)
      expect(h.state, step).toEqual({ live: false, pending: false })
      expect(h.events, step).not.toContain('enter')
    }
  })

  it('lets nothing in when a block landed before the answer, though the answer is yes', async () => {
    const h = harness({ declarations: [{ kind: 'mismatch', differing: ['/index.html'] }] })
    h.consent.mockImplementation(async () => { await vi.waitFor(() => { expect(h.blocked).toHaveBeenCalled() }); return true })
    const result = await run(h)
    expect(result.outcome).toBe('left')
    expect(await grantsOf(h)).toEqual([])
    expect(h.state).toEqual({ live: false, pending: false })
    expect(h.loader.serveLive).not.toHaveBeenCalled()
  })

  it('takes nothing of the app away until its pages are gone, and waits for the person to read the warning last', async () => {
    let emptied = (): void => {}
    let dismissed = (): void => {}
    const h = harness()
    h.blocked.mockImplementation(() => ({ emptied: new Promise<void>((resolve) => { emptied = resolve }), dismissed: new Promise<void>((resolve) => { dismissed = resolve }) }))
    const result = await run(h, present, undefined, LATE)
    h.badData()?.({ differing: ['/app.js'] })
    await vi.waitFor(() => { expect(h.blocked).toHaveBeenCalled() })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(h.broker.app.isRegisteredSync(h.origin)).toBe(true)
    expect(h.loader.endLive).not.toHaveBeenCalled()
    emptied()
    await vi.waitFor(() => { expect(h.loader.endLive).toHaveBeenCalled() })
    expect(h.broker.app.isRegisteredSync(h.origin)).toBe(false)
    dismissed()
    expect(await settled(result)).toBe('blocked')
  })

  it('names content the verifier proved is not what its address names, rather than a file', async () => {
    const h = harness()
    const result = await run(h, present, undefined, LATE)
    h.badData()?.({ differing: [], invalid: '/index.html is not what its address names' })
    await vi.waitFor(() => { expect(h.blocked).toHaveBeenCalled() })
    expect(h.blocked).toHaveBeenCalledWith(h.origin, expect.objectContaining({ kind: 'blocked', invalid: '/index.html is not what its address names' }), TAB)
    await settled(result)
  })

  it('does not pin what a block was raised over before the download began', async () => {
    const h = harness()
    const result = await run(h, present, undefined, LATE)
    h.badData()?.({ differing: ['/index.html'] })
    expect(await settled(result)).toBe('blocked')
    expect(h.loader.installFetched).not.toHaveBeenCalled()
  })

  it('still revokes what an earlier version of Orivon had granted to an origin it blocks', async () => {
    const h = harness({ declarations: [{ kind: 'mismatch', differing: ['/.well-known/orivon.json'] }] })
    await h.broker.grant(h.origin, 'fs', [])
    await run(h)
    await vi.waitFor(async () => { expect(await grantsOf(h)).toEqual([]) })
  })

  it('shows a retry sheet when the declared tree cannot be read, keeps the answer, and reads it again without asking again', async () => {
    const h = harness({ declarations: [{ kind: 'failed', reason: 'gateway 502' }, DECLARED], choices: ['retry'] })
    const result = await run(h)
    expect(result.outcome).toBe('entered')
    expect(h.events.slice(0, 6)).toEqual(['read', 'declaration', 'ask', 'sheet:download-failed', 'declaration', 'serve-live'])
    expect(h.consent).toHaveBeenCalledTimes(1)
    expect(h.host.sheets[0]).toMatchObject({ kind: 'download-failed', name: 'Test App', reason: 'gateway 502' })
    await settled(result)
  })

  it('opens nothing and grants nothing when the person leaves the retry sheet', async () => {
    const h = harness({ declarations: [{ kind: 'failed', reason: 'gateway 502' }], choices: ['leave'] })
    expect(await run(h)).toMatchObject({ outcome: 'failed' })
    expect(h.events.at(-1)).toBe('end')
    expect(h.loader.serveLive).not.toHaveBeenCalled()
    expect(await grantsOf(h)).toEqual([])
    expect(h.declined.has(h.origin)).toBe(false)
  })

  it('opens nothing and grants nothing when the app cannot be served live, rather than let an unchecked page in', async () => {
    for (const live of [false, 'throws'] as const) {
      const h = harness({ live })
      vi.spyOn(console, 'error').mockImplementation(() => {})
      expect(await run(h), String(live)).toMatchObject({ outcome: 'failed' })
      expect(h.events, String(live)).not.toContain('enter')
      expect(h.broker.app.isRegisteredSync(h.origin), String(live)).toBe(false)
      expect(await grantsOf(h), String(live)).toEqual([])
    }
  })

  it('asks nothing of a manifest that declares nothing, and still checks every file as it is served', async () => {
    const empty: Manifest = { ...MANIFEST, capabilities: {} }
    const h = harness({ reads: [{ ...readOf(VERIFIED), manifest: empty } as FirstManifest], bundles: [bundle(VERIFIED, { manifest: empty })] })
    const result = await run(h)
    expect(result.outcome).toBe('entered')
    expect(h.consent).not.toHaveBeenCalled()
    expect(h.events.slice(0, 7)).toEqual(['read', 'declaration', 'serve-live', 'remember', 'enter'])
    await settled(result)
  })

  it('on a pressed Deny downloads nothing, grants nothing, serves nothing live, records the refusal and opens a plain website', async () => {
    const h = harness({ answer: false })
    expect(await run(h)).toMatchObject({ outcome: 'plain', why: 'denied' })
    expect(h.events).toEqual(['read', 'declaration', 'ask', 'plain'])
    expect(h.loader.serveLive).not.toHaveBeenCalled()
    expect(h.loader.fetchForInstall).not.toHaveBeenCalled()
    expect(h.broker.app.isRegisteredSync(h.origin)).toBe(false)
    expect(h.declined.has(h.origin)).toBe(true)
    expect(await h.broker.declinedCapabilitiesFor(h.origin)).toBeUndefined()
  })

  it('on Escape records nothing and means not now: nothing is served, granted or discarded, and the staged cache is kept', async () => {
    const h = harness({ answer: 'dismissed' })
    expect((await run(h)).outcome).toBe('later')
    expect(h.events).toEqual(['read', 'declaration', 'ask', 'end'])
    expect(h.declined.has(h.origin)).toBe(false)
    expect(h.loader.serveLive).not.toHaveBeenCalled()
  })

  it('stops reading the declared tree when the visit ends without an app', async () => {
    const h = harness({ answer: 'dismissed' })
    await run(h)
    const signal = vi.mocked(h.loader.readDeclaration).mock.calls[0]?.[1]
    expect(signal?.aborted).toBe(true)
  })

  it('does not enter a tab that left while the tree was being read after the answer, and grants nothing', async () => {
    let away = false
    let release = (): void => {}
    const h = harness({ declarationGate: new Promise<void>((resolve) => { release = resolve }) })
    const leaving: DialogCaller = { window: () => undefined, stillOn: () => !away }
    const pending = run(h, leaving)
    await vi.waitFor(() => { expect(h.consent).toHaveBeenCalled() })
    away = true
    release()
    expect((await pending).outcome).toBe('left')
    expect(h.loader.serveLive).not.toHaveBeenCalled()
    expect(await grantsOf(h)).toEqual([])
  })

  it('does not enter a tab that left as the app was let in, though the app is granted and goes on to be pinned', async () => {
    const h = harness()
    const leaving: DialogCaller = { window: () => undefined, stillOn: () => !h.events.includes('serve-live') }
    const result = await run(h, leaving)
    expect(result.outcome).toBe('entered')
    expect(h.events).not.toContain('enter')
    expect(h.events).toContain('end')
    expect(await grantsOf(h)).toEqual(['fs'])
    expect(await settled(result)).toBe('pinned')
  })

  it('bounds the first look at the address only', async () => {
    const h = harness()
    await settled(await run(h))
    expect(vi.mocked(h.loader.readManifest).mock.calls[0]).toEqual([h.url, MANIFEST_PROBE_MS])
  })

  it('opens a site that has no manifest as a plain website, asking nothing', async () => {
    const h = harness({ reads: [{ kind: 'website' }] })
    expect((await run(h)).outcome).toBe('plain')
    expect(h.events).toEqual(['read', 'plain'])
  })

  it('opens a site whose manifest could not be read in time as an ordinary page', async () => {
    const h = harness({ reads: [{ kind: 'unread', reason: 'gateway down' }] })
    expect(await run(h)).toMatchObject({ outcome: 'plain', why: 'unread' })
    expect(h.events).toEqual(['read', 'plain'])
  })

  it('refuses an origin the hinted address is not the origin of', async () => {
    const h = harness()
    const result = await runFirstVisit(depsOf(h), 'https://other.example', h.url, present, h.host)
    expect(result.outcome).toBe('rejected')
    expect(h.events).toEqual([])
  })
})

