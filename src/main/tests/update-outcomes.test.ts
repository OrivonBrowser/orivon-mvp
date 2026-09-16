import { describe, expect, it, vi } from 'vitest'
import { driveLoadResult } from '../update-outcomes.js'
import type { UpdateOutcomeDeps } from '../update-outcomes.js'
import { APP } from '../../broker/transport/tests/ipc.test-helpers.js'
import type { BrokerCall } from '../../broker/transport/tests/ipc.test-helpers.js'
import type { LoadContext, LoadNeedsCapabilityPrompt, LoadNeedsReconsent, LoadNeedsRollbackChoice, LoadResult } from '../../loader/index.js'
import type { Grant, Manifest } from '../../contracts/index.js'
import { fakeBroker, fakeLoader, manifestWith, manifestWithCapabilities } from './app-install.test-helpers.js'

// S4-5 (docs/planning/step-4-app-loader-plan.md): driveLoadResult drives
// Loader.load()'s three pending outcomes to a real decision. Every "declines"
// or "no prompt wired" case must be provably a no-op -- the previously
// pinned bundle stays exactly as it was, never a half-state -- so most tests
// below assert an ABSENCE of a call (installFetched/reconsider/grant) rather
// than only a return value.

const NO_GRANTS: LoadContext = { grantedPatterns: {}, versionFloor: '0.0.0', acknowledgedRollbackVersion: undefined }

function fakeTree (): { root: string, assets: [] } {
  return { root: 'sha256:' + 'a'.repeat(64), assets: [] }
}

function reconsentResult (manifest = manifestWith()): LoadNeedsReconsent {
  return { outcome: 'needs-reconsent', canonicalOrigin: APP, manifest, tree: fakeTree(), entries: [] }
}

function capabilityPromptResult (manifest = manifestWithCapabilities(), requestedPatterns: LoadNeedsCapabilityPrompt['requestedPatterns'] = { 'tcp.connect': ['api.example.com:443'] }): LoadNeedsCapabilityPrompt {
  return { outcome: 'needs-capability-prompt', canonicalOrigin: APP, manifest, tree: fakeTree(), entries: [], requestedPatterns }
}

function rollbackChoiceResult (manifest = manifestWith('0.7.3'), versionFloor = '1.0.0'): LoadNeedsRollbackChoice {
  return { outcome: 'needs-rollback-choice', canonicalOrigin: APP, manifest, tree: fakeTree(), entries: [], versionFloor }
}

describe('driveLoadResult: needs-reconsent', () => {
  it('fails closed -- returns the pending result unchanged -- when no reconsentPrompt is wired', async () => {
    const pending = reconsentResult()
    const loader = fakeLoader({ outcome: 'rejected', reason: 'unused' })
    const deps: UpdateOutcomeDeps = { broker: fakeBroker(), loader }

    const result = await driveLoadResult(deps, pending, NO_GRANTS)

    expect(result).toBe(pending)
    expect(loader.installFetched).not.toHaveBeenCalled()
  })

  it('a thrown prompt is treated as declined, and logs rather than propagating', async () => {
    const pending = reconsentResult()
    const loader = fakeLoader({ outcome: 'rejected', reason: 'unused' })
    const reconsentPrompt = vi.fn(async (): Promise<boolean> => { throw new Error('dialog crashed') })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await driveLoadResult({ broker: fakeBroker(), loader, reconsentPrompt }, pending, NO_GRANTS)

    expect(result).toBe(pending)
    expect(loader.installFetched).not.toHaveBeenCalled()
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  // The exit criterion this lane names verbatim: "declining leaves the
  // previously pinned bundle in place and running." Nothing on the LOADER
  // side is ever touched on decline -- there is no separate "undo" path
  // because nothing was ever done.
  it('declining leaves the previously pinned bundle intact -- installFetched is never called, registerApp is never called', async () => {
    const pending = reconsentResult()
    const loader = fakeLoader({ outcome: 'rejected', reason: 'unused' })
    const registerApp = vi.fn(async () => {})
    const reconsentPrompt = vi.fn(async () => false)

    const result = await driveLoadResult({ broker: fakeBroker({ registerApp }), loader, reconsentPrompt }, pending, NO_GRANTS)

    expect(result).toBe(pending)
    expect(loader.installFetched).not.toHaveBeenCalled()
    expect(registerApp).not.toHaveBeenCalled()
  })

  // The security property this lane exists to prove: accepting installs
  // EXACTLY the bytes already fetched, never a second Loader.load() call
  // (which would be a second network fetch, and a second chance for the
  // server to serve something else). `tree`/`entries` are asserted by
  // REFERENCE, not merely deep-equal, to prove they are the very objects
  // the person was shown -- not a re-derived or re-fetched copy.
  it('accepting installs the bytes already fetched -- installFetched receives the exact tree/entries, and load() is never called', async () => {
    const pending = reconsentResult()
    const installed: LoadResult = { outcome: 'installed', canonicalOrigin: APP, manifest: pending.manifest, pin: { schema: 1, origin: APP, bundleHash: pending.tree.root, assets: [], version: pending.manifest.version, pinnedAt: 0 } }
    const loader = fakeLoader({ outcome: 'rejected', reason: 'unused' }, { installFetched: vi.fn(async () => installed) })
    const reconsentPrompt = vi.fn(async () => true)

    const result = await driveLoadResult({ broker: fakeBroker(), loader, reconsentPrompt }, pending, NO_GRANTS)

    expect(loader.installFetched).toHaveBeenCalledExactlyOnceWith(pending.canonicalOrigin, pending.manifest, pending.tree, pending.entries)
    expect(loader.load).not.toHaveBeenCalled()
    expect(result).toBe(installed)
  })

  it('a rejected installFetched (a storage failure) is returned as-is, and never runs registerApp/consent', async () => {
    const pending = reconsentResult()
    const rejected: LoadResult = { outcome: 'rejected', reason: 'disk full' }
    const loader = fakeLoader({ outcome: 'rejected', reason: 'unused' }, { installFetched: vi.fn(async () => rejected) })
    const registerApp = vi.fn(async () => {})
    const reconsentPrompt = vi.fn(async () => true)

    const result = await driveLoadResult({ broker: fakeBroker({ registerApp }), loader, reconsentPrompt }, pending, NO_GRANTS)

    expect(result).toBe(rejected)
    expect(registerApp).not.toHaveBeenCalled()
  })

  it('registerApp runs, and consent is offered, once an accepted reconsent actually installs', async () => {
    const pending = reconsentResult()
    const installed: LoadResult = { outcome: 'installed', canonicalOrigin: APP, manifest: pending.manifest, pin: { schema: 1, origin: APP, bundleHash: pending.tree.root, assets: [], version: pending.manifest.version, pinnedAt: 0 } }
    const loader = fakeLoader({ outcome: 'rejected', reason: 'unused' }, { installFetched: vi.fn(async () => installed) })
    const registerApp = vi.fn(async () => {})
    const consent = vi.fn(async () => true)
    const reconsentPrompt = vi.fn(async () => true)

    await driveLoadResult({ broker: fakeBroker({ registerApp }), loader, consent, reconsentPrompt }, pending, NO_GRANTS)

    expect(registerApp).toHaveBeenCalledExactlyOnceWith(APP, pending.manifest)
    // manifestWith()'s default manifest declares no capabilities, so
    // requestInstallConsent's own dedup (install-consent.ts) never reaches
    // the prompt -- this only proves registerApp ran BEFORE it, matching
    // finishInstall's own ordering.
    expect(consent).not.toHaveBeenCalled()
  })
})

describe('driveLoadResult: needs-capability-prompt', () => {
  it('fails closed when no capabilityPrompt is wired', async () => {
    const pending = capabilityPromptResult()
    const loader = fakeLoader({ outcome: 'rejected', reason: 'unused' })

    const result = await driveLoadResult({ broker: fakeBroker(), loader }, pending, NO_GRANTS)

    expect(result).toBe(pending)
    expect(loader.installFetched).not.toHaveBeenCalled()
  })

  it('declining leaves the previously pinned bundle intact -- no install, no grant', async () => {
    const calls: BrokerCall[] = []
    const pending = capabilityPromptResult()
    const loader = fakeLoader({ outcome: 'rejected', reason: 'unused' })
    const capabilityPrompt = vi.fn(async () => false)

    const result = await driveLoadResult({ broker: fakeBroker({}, calls), loader, capabilityPrompt }, pending, NO_GRANTS)

    expect(result).toBe(pending)
    expect(loader.installFetched).not.toHaveBeenCalled()
    expect(calls.some((call) => call.method === 'grant')).toBe(false)
  })

  it('the prompt is called with the widened patterns the update actually asks for', async () => {
    const requestedPatterns = { 'tcp.connect': ['*:*'] as const }
    const pending = capabilityPromptResult(manifestWithCapabilities(), requestedPatterns)
    const loader = fakeLoader({ outcome: 'rejected', reason: 'unused' })
    const capabilityPrompt = vi.fn(async () => false)

    await driveLoadResult({ broker: fakeBroker(), loader, capabilityPrompt }, pending, NO_GRANTS)

    expect(capabilityPrompt).toHaveBeenCalledExactlyOnceWith(APP, pending.manifest, requestedPatterns)
  })

  it('accepting installs the bytes already fetched, with no second loader.load() call', async () => {
    const pending = capabilityPromptResult()
    const installed: LoadResult = { outcome: 'installed', canonicalOrigin: APP, manifest: pending.manifest, pin: { schema: 1, origin: APP, bundleHash: pending.tree.root, assets: [], version: pending.manifest.version, pinnedAt: 0 } }
    const loader = fakeLoader({ outcome: 'rejected', reason: 'unused' }, { installFetched: vi.fn(async () => installed) })
    const capabilityPrompt = vi.fn(async () => true)

    const result = await driveLoadResult({ broker: fakeBroker(), loader, capabilityPrompt }, pending, NO_GRANTS)

    expect(loader.installFetched).toHaveBeenCalledExactlyOnceWith(pending.canonicalOrigin, pending.manifest, pending.tree, pending.entries)
    expect(loader.load).not.toHaveBeenCalled()
    expect(result.outcome).toBe('installed')
  })

  it('grants exactly the capability the manifest declares, once accepted', async () => {
    const calls: BrokerCall[] = []
    const pending = capabilityPromptResult()
    const installed: LoadResult = { outcome: 'installed', canonicalOrigin: APP, manifest: pending.manifest, pin: { schema: 1, origin: APP, bundleHash: pending.tree.root, assets: [], version: pending.manifest.version, pinnedAt: 0 } }
    const loader = fakeLoader({ outcome: 'rejected', reason: 'unused' }, { installFetched: vi.fn(async () => installed) })
    const capabilityPrompt = vi.fn(async () => true)

    await driveLoadResult({ broker: fakeBroker({}, calls), loader, capabilityPrompt }, pending, NO_GRANTS)

    expect(calls).toContainEqual({ method: 'grant', origin: APP, args: { capability: 'tcp.connect', patterns: ['api.example.com:443'] } })
  })

  // A172(3), MEDIUM: `requestedPatterns` is the manifest's WHOLE current
  // declared set (patternSetFromCapabilities(manifest.capabilities),
  // src/loader/index.ts) -- the same construction install-consent.ts's own
  // all-or-nothing accept uses for `capabilities` -- so accepting this
  // prompt is the same kind of "yes to everything declared" as that accept
  // branch, and must clear an old decline the same way. It did not:
  // `clearDeclinedConsent`'s only caller anywhere in this tree used to be
  // install-consent.ts's own accept branch, which this outcome does not
  // reach when nothing is left unheld once grantChangedCapabilities runs.
  it('A172(3): accepting clears any earlier declined-consent record for this origin', async () => {
    const calls: BrokerCall[] = []
    const pending = capabilityPromptResult()
    const installed: LoadResult = { outcome: 'installed', canonicalOrigin: APP, manifest: pending.manifest, pin: { schema: 1, origin: APP, bundleHash: pending.tree.root, assets: [], version: pending.manifest.version, pinnedAt: 0 } }
    const loader = fakeLoader({ outcome: 'rejected', reason: 'unused' }, { installFetched: vi.fn(async () => installed) })
    const capabilityPrompt = vi.fn(async () => true)

    await driveLoadResult({ broker: fakeBroker({ declinedCapabilities: ['fs'] }, calls), loader, capabilityPrompt }, pending, NO_GRANTS)

    expect(calls).toContainEqual({ method: 'clearDeclinedConsent', origin: APP, args: undefined })
  })

  // capability-api.md design rule 4: a grant can never exceed the manifest.
  // Even if a caller handed driveLoadResult a `requestedPatterns` claiming
  // MORE than the manifest itself declares -- the shape a bug upstream, or
  // a hostile Loader implementation, could produce -- decideGrantRequest
  // still bounds what actually reaches broker.grant to the manifest's own
  // patterns, and never grants a capability the manifest never declared at
  // all.
  it('never grants beyond what the manifest itself declares, even if requestedPatterns claims more', async () => {
    const calls: BrokerCall[] = []
    const manifest = manifestWithCapabilities() // declares only tcp.connect -> ['api.example.com:443']
    const overclaiming = {
      'tcp.connect': ['*:*'], // wider than the manifest's own narrow pattern
      fs: [] // a capability this manifest never declared at all
    } as const
    const pending = capabilityPromptResult(manifest, overclaiming)
    const installed: LoadResult = { outcome: 'installed', canonicalOrigin: APP, manifest, pin: { schema: 1, origin: APP, bundleHash: pending.tree.root, assets: [], version: manifest.version, pinnedAt: 0 } }
    const loader = fakeLoader({ outcome: 'rejected', reason: 'unused' }, { installFetched: vi.fn(async () => installed) })
    const capabilityPrompt = vi.fn(async () => true)

    await driveLoadResult({ broker: fakeBroker({}, calls), loader, capabilityPrompt }, pending, NO_GRANTS)

    const grantCalls = calls.filter((call) => call.method === 'grant')
    // tcp.connect is granted, but bounded to the MANIFEST's own pattern --
    // never the wider '*:*' the (hypothetically corrupted) requestedPatterns claimed.
    expect(grantCalls).toContainEqual({ method: 'grant', origin: APP, args: { capability: 'tcp.connect', patterns: ['api.example.com:443'] } })
    // fs was never declared by the manifest at all, so decideGrantRequest
    // refuses it outright -- no grant call for it, however requestedPatterns
    // was built.
    expect(grantCalls.some((call) => (call.args as { capability: string }).capability === 'fs')).toBe(false)
  })

  // Finding 2 (A156, docs/open-questions.md): grantDeclared used to call
  // broker.grant() for EVERY capability in requestedPatterns unconditionally
  // -- the manifest's whole declared set, not the delta. broker.grant()
  // mints a fresh GrantId and tears down every live handle under whatever
  // grant it replaces (broker/index.ts's own grant()), so re-granting a
  // capability whose authority did not actually change kills a real,
  // unrelated, in-progress connection for no reason the person could see:
  // they accepted a dialog about fs, and their open tcp.connect socket died.
  it('does not re-grant a capability the origin already holds unchanged, but still grants a genuinely new one', async () => {
    const calls: BrokerCall[] = []
    const manifest: Manifest = {
      orivonApiVersion: 0,
      id: 'app.test',
      name: 'Test',
      version: '1.0.0',
      entry: 'index.html',
      capabilities: { net: { tcp: { connect: ['api.example.com:443'] } }, fs: { quotaBytes: 1024 } }
    }
    const requestedPatterns = { 'tcp.connect': ['api.example.com:443'], fs: [] } as const
    const pending = capabilityPromptResult(manifest, requestedPatterns)
    const installed: LoadResult = { outcome: 'installed', canonicalOrigin: APP, manifest, pin: { schema: 1, origin: APP, bundleHash: pending.tree.root, assets: [], version: manifest.version, pinnedAt: 0 } }
    const loader = fakeLoader({ outcome: 'rejected', reason: 'unused' }, { installFetched: vi.fn(async () => installed) })
    const capabilityPrompt = vi.fn(async () => true)
    // Already held, with EXACTLY the manifest's own declared pattern -- an
    // existing, live grant this update never touches.
    const existingGrant: Grant = { id: 'g0', origin: APP, capability: 'tcp.connect', patterns: ['api.example.com:443'], grantedAt: 0 }

    await driveLoadResult({ broker: fakeBroker({ grants: [existingGrant] }, calls), loader, capabilityPrompt }, pending, NO_GRANTS)

    const grantCalls = calls.filter((call) => call.method === 'grant')
    expect(grantCalls.some((call) => (call.args as { capability: string }).capability === 'tcp.connect')).toBe(false)
    // fs is a genuinely new capability and must still be granted.
    expect(grantCalls).toContainEqual({ method: 'grant', origin: APP, args: { capability: 'fs', patterns: [] } })
  })

  it('treats the same patterns in a different order as unchanged -- no re-grant', async () => {
    const calls: BrokerCall[] = []
    const manifest: Manifest = {
      orivonApiVersion: 0,
      id: 'app.test',
      name: 'Test',
      version: '1.0.0',
      entry: 'index.html',
      capabilities: { net: { tcp: { connect: ['a.example.com:443', 'b.example.com:443'] } } }
    }
    const requestedPatterns = { 'tcp.connect': ['a.example.com:443', 'b.example.com:443'] } as const
    const pending = capabilityPromptResult(manifest, requestedPatterns)
    const installed: LoadResult = { outcome: 'installed', canonicalOrigin: APP, manifest, pin: { schema: 1, origin: APP, bundleHash: pending.tree.root, assets: [], version: manifest.version, pinnedAt: 0 } }
    const loader = fakeLoader({ outcome: 'rejected', reason: 'unused' }, { installFetched: vi.fn(async () => installed) })
    const capabilityPrompt = vi.fn(async () => true)
    // Same two patterns, reverse order -- must still read as "unchanged", not
    // as a widening that happens to net out to the same set.
    const existingGrant: Grant = { id: 'g0', origin: APP, capability: 'tcp.connect', patterns: ['b.example.com:443', 'a.example.com:443'], grantedAt: 0 }

    await driveLoadResult({ broker: fakeBroker({ grants: [existingGrant] }, calls), loader, capabilityPrompt }, pending, NO_GRANTS)

    expect(calls.some((call) => call.method === 'grant')).toBe(false)
  })

  it('still re-grants a capability whose pattern set actually narrowed', async () => {
    const calls: BrokerCall[] = []
    const manifest: Manifest = {
      orivonApiVersion: 0,
      id: 'app.test',
      name: 'Test',
      version: '1.0.0',
      entry: 'index.html',
      capabilities: { net: { tcp: { connect: ['a.example.com:443'] } } }
    }
    const requestedPatterns = { 'tcp.connect': ['a.example.com:443'] } as const
    const pending = capabilityPromptResult(manifest, requestedPatterns)
    const installed: LoadResult = { outcome: 'installed', canonicalOrigin: APP, manifest, pin: { schema: 1, origin: APP, bundleHash: pending.tree.root, assets: [], version: manifest.version, pinnedAt: 0 } }
    const loader = fakeLoader({ outcome: 'rejected', reason: 'unused' }, { installFetched: vi.fn(async () => installed) })
    const capabilityPrompt = vi.fn(async () => true)
    // The origin previously held BOTH hosts; the manifest now declares only
    // one -- a genuine authority change, which must still re-grant (and
    // therefore still tear down whatever the wider grant authorised).
    const existingGrant: Grant = { id: 'g0', origin: APP, capability: 'tcp.connect', patterns: ['a.example.com:443', 'b.example.com:443'], grantedAt: 0 }

    await driveLoadResult({ broker: fakeBroker({ grants: [existingGrant] }, calls), loader, capabilityPrompt }, pending, NO_GRANTS)

    expect(calls).toContainEqual({ method: 'grant', origin: APP, args: { capability: 'tcp.connect', patterns: ['a.example.com:443'] } })
  })
})

describe('driveLoadResult: needs-rollback-choice', () => {
  it('fails closed when no rollbackChoicePrompt is wired', async () => {
    const pending = rollbackChoiceResult()
    const loader = fakeLoader({ outcome: 'rejected', reason: 'unused' })
    const acknowledgeRollback = vi.fn(async () => {})

    const result = await driveLoadResult({ broker: fakeBroker({ acknowledgeRollback }), loader }, pending, NO_GRANTS)

    expect(result).toBe(pending)
    expect(acknowledgeRollback).not.toHaveBeenCalled()
    expect(loader.reconsider).not.toHaveBeenCalled()
  })

  it('declining leaves the previously pinned bundle intact -- no acknowledgement, no reconsider', async () => {
    const pending = rollbackChoiceResult()
    const loader = fakeLoader({ outcome: 'rejected', reason: 'unused' })
    const acknowledgeRollback = vi.fn(async () => {})
    const rollbackChoicePrompt = vi.fn(async () => false)

    const result = await driveLoadResult({ broker: fakeBroker({ acknowledgeRollback }), loader, rollbackChoicePrompt }, pending, NO_GRANTS)

    expect(result).toBe(pending)
    expect(acknowledgeRollback).not.toHaveBeenCalled()
    expect(loader.reconsider).not.toHaveBeenCalled()
  })

  it('the prompt receives the origin\'s own version floor, not just the offered version', async () => {
    const pending = rollbackChoiceResult(manifestWith('0.7.3'), '1.4.0')
    const loader = fakeLoader({ outcome: 'rejected', reason: 'unused' })
    const rollbackChoicePrompt = vi.fn(async () => false)

    await driveLoadResult({ broker: fakeBroker(), loader, rollbackChoicePrompt }, pending, NO_GRANTS)

    expect(rollbackChoicePrompt).toHaveBeenCalledExactlyOnceWith(APP, pending.manifest, '1.4.0')
  })

  // A68 (docs/open-questions.md): the acknowledgement is the SPECIFIC
  // version just offered, never a per-origin flag -- so a LATER, different
  // below-floor version is not silently waved through by this one.
  it('acknowledges exactly the offered version, and re-runs the decision with NO second fetch', async () => {
    const pending = rollbackChoiceResult(manifestWith('0.7.3'), '1.4.0')
    const context: LoadContext = { grantedPatterns: { 'tcp.connect': ['api.example.com:443'] }, versionFloor: '1.4.0', acknowledgedRollbackVersion: undefined }
    const acknowledgeRollback = vi.fn(async () => {})
    const reconsidered: LoadResult = { outcome: 'installed', canonicalOrigin: APP, manifest: pending.manifest, pin: { schema: 1, origin: APP, bundleHash: pending.tree.root, assets: [], version: '0.7.3', pinnedAt: 0 }, rollbackNotice: true }
    const loader = fakeLoader({ outcome: 'rejected', reason: 'unused' }, { reconsider: vi.fn(async () => reconsidered) })
    const rollbackChoicePrompt = vi.fn(async () => true)

    const result = await driveLoadResult({ broker: fakeBroker({ acknowledgeRollback }), loader, rollbackChoicePrompt }, pending, context)

    expect(acknowledgeRollback).toHaveBeenCalledExactlyOnceWith(APP, '0.7.3')
    // reconsider() is handed the SAME tree/entries the person was shown --
    // never load(), which would be a second network fetch.
    expect(loader.reconsider).toHaveBeenCalledExactlyOnceWith(pending.canonicalOrigin, pending.manifest, pending.tree, pending.entries, {
      ...context,
      acknowledgedRollbackVersion: '0.7.3'
    })
    expect(loader.load).not.toHaveBeenCalled()
    expect(result).toBe(reconsidered)
  })

  it('a version rejected by acknowledgeRollback\'s own write still proceeds to reconsider for this session', async () => {
    const pending = rollbackChoiceResult()
    const reconsidered: LoadResult = { outcome: 'rejected', reason: 'unused after acknowledge' }
    const loader = fakeLoader({ outcome: 'rejected', reason: 'unused' }, { reconsider: vi.fn(async () => reconsidered) })
    const acknowledgeRollback = vi.fn(async () => { throw new Error('EACCES') })
    const rollbackChoicePrompt = vi.fn(async () => true)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await driveLoadResult({ broker: fakeBroker({ acknowledgeRollback }), loader, rollbackChoicePrompt }, pending, NO_GRANTS)

    expect(loader.reconsider).toHaveBeenCalledOnce()
    expect(result).toBe(reconsidered)
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  // ADR-0013's 2026-09-05 amendment: an acknowledged rollback is never LESS
  // scrutinised than an ordinary update carrying the same change -- if
  // reconsider() itself comes back with a widened-capability prompt, that
  // must still be driven through the SAME capability-prompt handling, not
  // silently installed.
  it('a reconsidered result that still needs a capability prompt is driven through the same handling, recursively', async () => {
    const pending = rollbackChoiceResult()
    const widened = capabilityPromptResult()
    const installed: LoadResult = { outcome: 'installed', canonicalOrigin: APP, manifest: widened.manifest, pin: { schema: 1, origin: APP, bundleHash: widened.tree.root, assets: [], version: widened.manifest.version, pinnedAt: 0 } }
    const loader = fakeLoader({ outcome: 'rejected', reason: 'unused' }, {
      reconsider: vi.fn(async () => widened),
      installFetched: vi.fn(async () => installed)
    })
    const rollbackChoicePrompt = vi.fn(async () => true)
    const capabilityPrompt = vi.fn(async () => true)
    const calls: BrokerCall[] = []

    const result = await driveLoadResult({ broker: fakeBroker({ acknowledgeRollback: async () => {} }, calls), loader, rollbackChoicePrompt, capabilityPrompt }, pending, NO_GRANTS)

    expect(capabilityPrompt).toHaveBeenCalledExactlyOnceWith(APP, widened.manifest, widened.requestedPatterns)
    expect(loader.installFetched).toHaveBeenCalledExactlyOnceWith(widened.canonicalOrigin, widened.manifest, widened.tree, widened.entries)
    expect(calls).toContainEqual({ method: 'grant', origin: APP, args: { capability: 'tcp.connect', patterns: ['api.example.com:443'] } })
    expect(result).toBe(installed)
  })

  it('a reconsidered result with no further prompt needed (rollback-notice) still runs registerApp', async () => {
    const pending = rollbackChoiceResult()
    const registerApp = vi.fn(async () => {})
    const reconsidered: LoadResult = { outcome: 'installed', canonicalOrigin: APP, manifest: pending.manifest, pin: { schema: 1, origin: APP, bundleHash: pending.tree.root, assets: [], version: pending.manifest.version, pinnedAt: 0 }, rollbackNotice: true }
    const loader = fakeLoader({ outcome: 'rejected', reason: 'unused' }, { reconsider: vi.fn(async () => reconsidered) })
    const rollbackChoicePrompt = vi.fn(async () => true)

    const result = await driveLoadResult({ broker: fakeBroker({ acknowledgeRollback: async () => {}, registerApp }), loader, rollbackChoicePrompt }, pending, NO_GRANTS)

    expect(registerApp).toHaveBeenCalledExactlyOnceWith(APP, pending.manifest)
    expect(result).toBe(reconsidered)
  })
})

describe('driveLoadResult: passthrough outcomes', () => {
  it('installed: registers the app and offers consent', async () => {
    const manifest = manifestWith()
    const installed: LoadResult = { outcome: 'installed', canonicalOrigin: APP, manifest, pin: { schema: 1, origin: APP, bundleHash: 'sha256:' + 'a'.repeat(64), assets: [], version: manifest.version, pinnedAt: 0 } }
    const registerApp = vi.fn(async () => {})

    const result = await driveLoadResult({ broker: fakeBroker({ registerApp }), loader: fakeLoader({ outcome: 'rejected', reason: 'unused' }) }, installed, NO_GRANTS)

    expect(registerApp).toHaveBeenCalledExactlyOnceWith(APP, manifest)
    expect(result).toBe(installed)
  })

  it('rejected: returned unchanged, never touches the broker', async () => {
    const rejected: LoadResult = { outcome: 'rejected', reason: 'malformed manifest' }
    const registerApp = vi.fn(async () => {})

    const result = await driveLoadResult({ broker: fakeBroker({ registerApp }), loader: fakeLoader({ outcome: 'rejected', reason: 'unused' }) }, rejected, NO_GRANTS)

    expect(result).toBe(rejected)
    expect(registerApp).not.toHaveBeenCalled()
  })
})
