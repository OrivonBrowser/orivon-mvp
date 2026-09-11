// Split out of grant-ledger.test.ts (code-guidelines.md Rule 2) once A23's
// own suite pushed that file past the 800-line test limit -- the grant
// persistence, hydration and revocation behaviour is its own concern,
// distinct from the version-floor/rollback-acknowledgement suites that
// stayed behind.

import { describe, expect, it } from 'vitest'
import { GrantLedger } from '../grant-ledger.js'
import { memoryLedgerStorage } from '../../tests/index.test-helpers.js'
import type { LedgerStorage } from '../ledger-storage.js'
import type { Manifest } from '../../../contracts/index.js'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBroker } from '../../index.js'
import { nodeLedgerStorage } from '../node-ledger-storage.js'
import { originHash } from '../origin-hash.js'
import { baseDeps } from '../../tests/index.test-helpers.js'

const APP = 'https://app.example'

/** A minimal, valid Manifest -- only `version`/`capabilities` vary per call. */
function manifestWith (version: string): Manifest {
  return { orivonApiVersion: 0, id: 'app.test', name: 'Test', version, entry: 'index.html', capabilities: {} }
}

/** A LedgerStorage double whose write always fails, matching grant-ledger.test.ts's own copy of the same idiom. */
function throwingLedgerStorage (): LedgerStorage {
  return {
    readVersionFloor: () => undefined,
    writeVersionFloor: () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }) },
    deleteVersionFloor: () => {},
    readAcknowledgedRollbackVersion: () => undefined,
    writeAcknowledgedRollbackVersion: () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }) },
    deleteAcknowledgedRollbackVersion: () => {},
    readGrants: () => undefined,
    writeGrants: () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }) },
    deleteGrants: () => {},
    listPersistedOrigins: () => [],
    readManifest: () => undefined,
    writeManifest: () => {},
    deleteManifest: () => {}
  }
}

/** A LedgerStorage double whose GRANTS write alone fails -- floor/rollback writes succeed, so `registerApp` never throws before a test reaches the grant/revoke call it actually means to exercise. */
function throwingGrantsLedgerStorage (): LedgerStorage {
  const storage = memoryLedgerStorage()
  return { ...storage, writeGrants: () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }) } }
}

// A23: "a grant lasts until the user revokes it" -- until now, GrantLedger
// persisted the version floor and the rollback acknowledgement but never the
// grants themselves. Same "a new GrantLedger stands in for a restart" idiom
// grant-ledger.test.ts's own A57 suite established.
describe('GrantLedger -- grant persistence (A23)', () => {
  function manifestFor (capabilities: Manifest['capabilities']): Manifest {
    return { ...manifestWith('1.0.0'), capabilities }
  }

  it('with no LedgerStorage supplied, behaves exactly as before -- in-memory only', () => {
    const ledger = new GrantLedger()
    ledger.registerApp(APP, manifestFor({ fs: { quotaBytes: 1 } }))
    ledger.grant(APP, 'fs', [], 0)

    expect(ledger.grantsFor(APP)).toHaveLength(1)
  })

  it('granting through the ledger persists via the injected storage', () => {
    const storage = memoryLedgerStorage()
    const ledger = new GrantLedger(storage)
    ledger.registerApp(APP, manifestFor({ fs: { quotaBytes: 1 } }))

    ledger.grant(APP, 'fs', [], 1234)

    expect(storage.grants.get(APP)).toEqual({ fs: { patterns: [], grantedAt: 1234 } })
  })

  it('a grant persisted before this GrantLedger existed is restored once the covering manifest is registered -- simulates surviving a restart', () => {
    const storage = memoryLedgerStorage()
    const before = new GrantLedger(storage)
    before.registerApp(APP, manifestFor({ net: { tcp: { connect: ['api.example.com:443'] } } }))
    before.grant(APP, 'tcp.connect', ['api.example.com:443'], 999)

    const after = new GrantLedger(storage) // the "restart"
    after.registerApp(APP, manifestFor({ net: { tcp: { connect: ['api.example.com:443'] } } }))

    const restored = after.currentGrant(APP, 'tcp.connect')
    expect(restored?.patterns).toEqual(['api.example.com:443'])
    expect(restored?.grantedAt).toBe(999)
  })

  // The security core of the whole feature: a restored grant is re-checked
  // against the manifest in force NOW, not the one in force when it was
  // granted. A narrowed manifest must not let the old, wider grant come back.
  it('does NOT restore a persisted grant whose patterns no longer fit the current (narrowed) manifest', () => {
    const storage = memoryLedgerStorage()
    const before = new GrantLedger(storage)
    before.registerApp(APP, manifestFor({ net: { tcp: { connect: ['*:*'] } } }))
    before.grant(APP, 'tcp.connect', ['*:*'], 1)

    const after = new GrantLedger(storage) // the "restart"
    after.registerApp(APP, manifestFor({ net: { tcp: { connect: ['api.example.com:443'] } } })) // narrowed

    expect(after.currentGrant(APP, 'tcp.connect')).toBeUndefined()
  })

  it('does NOT restore a persisted grant for a capability the current manifest no longer declares at all', () => {
    const storage = memoryLedgerStorage()
    const before = new GrantLedger(storage)
    before.registerApp(APP, manifestFor({ fs: { quotaBytes: 1 } }))
    before.grant(APP, 'fs', [], 1)

    const after = new GrantLedger(storage) // the "restart"
    after.registerApp(APP, manifestFor({})) // fs dropped entirely

    expect(after.currentGrant(APP, 'fs')).toBeUndefined()
  })

  it('mints a fresh GrantId for a restored grant rather than reusing the one from the session that created it', () => {
    const storage = memoryLedgerStorage()
    const before = new GrantLedger(storage)
    before.registerApp(APP, manifestFor({ fs: { quotaBytes: 1 } }))
    const { record: original } = before.grant(APP, 'fs', [], 1)

    const after = new GrantLedger(storage)
    after.registerApp(APP, manifestFor({ fs: { quotaBytes: 1 } }))

    expect(after.currentGrant(APP, 'fs')?.id).not.toBe(original.id)
  })

  // The other half of the exit criterion: "a revoked grant stays revoked
  // across the same cycle."
  it('revoking deletes the persisted grant, so a fresh GrantLedger (simulating a restart) does not restore it', () => {
    const storage = memoryLedgerStorage()
    const before = new GrantLedger(storage)
    before.registerApp(APP, manifestFor({ fs: { quotaBytes: 1 } }))
    const { record } = before.grant(APP, 'fs', [], 1)

    before.revoke(APP, record.id)

    const after = new GrantLedger(storage) // the "restart"
    after.registerApp(APP, manifestFor({ fs: { quotaBytes: 1 } }))
    expect(after.currentGrant(APP, 'fs')).toBeUndefined()
  })

  it('revoking one capability does not disturb another capability\'s persisted grant', () => {
    const storage = memoryLedgerStorage()
    const before = new GrantLedger(storage)
    before.registerApp(APP, manifestFor({ fs: { quotaBytes: 1 }, id: { curves: ['secp256k1'] } }))
    const { record: fsGrant } = before.grant(APP, 'fs', [], 1)
    before.grant(APP, 'id', [], 2)

    before.revoke(APP, fsGrant.id)

    const after = new GrantLedger(storage)
    after.registerApp(APP, manifestFor({ fs: { quotaBytes: 1 }, id: { curves: ['secp256k1'] } }))
    expect(after.currentGrant(APP, 'fs')).toBeUndefined()
    expect(after.currentGrant(APP, 'id')).toBeDefined()
  })

  it('re-granting the same capability persists the replacement, not the original', () => {
    const storage = memoryLedgerStorage()
    const ledger = new GrantLedger(storage)
    ledger.registerApp(APP, manifestFor({ net: { tcp: { connect: ['*:*'] } } }))
    ledger.grant(APP, 'tcp.connect', ['api.example.com:443'], 1)

    ledger.grant(APP, 'tcp.connect', ['other.example:443'], 2)

    expect(storage.grants.get(APP)).toEqual({ 'tcp.connect': { patterns: ['other.example:443'], grantedAt: 2 } })
  })

  it('hydration happens only once per session -- a later registerApp call does not resurrect an in-session revoke', () => {
    const storage = memoryLedgerStorage()
    storage.grants.set(APP, { fs: { patterns: [], grantedAt: 1 } })
    const ledger = new GrantLedger(storage)
    ledger.registerApp(APP, manifestFor({ fs: { quotaBytes: 1 } })) // hydrates and restores fs
    const restored = ledger.currentGrant(APP, 'fs')
    expect(restored).toBeDefined()
    ledger.revoke(APP, restored!.id)

    ledger.registerApp(APP, manifestFor({ fs: { quotaBytes: 1 } })) // a reload -- must not re-hydrate

    expect(ledger.currentGrant(APP, 'fs')).toBeUndefined()
  })

  it('two origins persist and hydrate independently', () => {
    const storage = memoryLedgerStorage()
    const before = new GrantLedger(storage)
    before.registerApp(APP, manifestFor({ fs: { quotaBytes: 1 } }))
    before.grant(APP, 'fs', [], 1)
    before.registerApp('https://other.example', manifestFor({ id: { curves: ['secp256k1'] } }))
    before.grant('https://other.example', 'id', [], 2)

    const after = new GrantLedger(storage)
    after.registerApp(APP, manifestFor({ fs: { quotaBytes: 1 } }))
    after.registerApp('https://other.example', manifestFor({ id: { curves: ['secp256k1'] } }))

    expect(after.currentGrant(APP, 'fs')).toBeDefined()
    expect(after.currentGrant(APP, 'id')).toBeUndefined()
    expect(after.currentGrant('https://other.example', 'id')).toBeDefined()
    expect(after.currentGrant('https://other.example', 'fs')).toBeUndefined()
  })
})

// T13c, the same rule the version floor and the rollback acknowledgement
// already honour: never persist authority for a loopback, `file:` or
// plain-http origin -- a developer server on that port next is not the
// origin the user actually granted anything to.
describe('GrantLedger -- grants on non-persistable origins never touch disk (A23/T13c)', () => {
  it.each([
    'http://127.0.0.1:8080',
    'http://[::1]:9000',
    'http://localhost:3000',
    'http://app.example'
  ])('%s: granting works normally in-memory but writes nothing to storage', (origin) => {
    const storage = memoryLedgerStorage()
    const ledger = new GrantLedger(storage)
    ledger.registerApp(origin, { ...manifestWith('1.0.0'), capabilities: { fs: { quotaBytes: 1 } } })

    ledger.grant(origin, 'fs', [], 1)

    expect(ledger.currentGrant(origin, 'fs')).toBeDefined() // still works in-memory
    expect(storage.grants.has(origin)).toBe(false) // never written
  })

  it('a non-persistable origin\'s grant does not survive a simulated restart -- it was never on disk to hydrate from', () => {
    const storage = memoryLedgerStorage()
    const before = new GrantLedger(storage)
    before.registerApp('http://127.0.0.1:8080', { ...manifestWith('1.0.0'), capabilities: { fs: { quotaBytes: 1 } } })
    before.grant('http://127.0.0.1:8080', 'fs', [], 1)

    const after = new GrantLedger(storage) // the "restart"
    after.registerApp('http://127.0.0.1:8080', { ...manifestWith('1.0.0'), capabilities: { fs: { quotaBytes: 1 } } })
    expect(after.currentGrant('http://127.0.0.1:8080', 'fs')).toBeUndefined()
  })

  // The read side is gated too, same discipline as the version floor's own
  // equivalent test: nothing in this codebase writes such a file, so this is
  // what stops one that arrived some other way from being honoured.
  it('grants already on disk for a non-persistable origin are NOT hydrated', () => {
    const storage = memoryLedgerStorage()
    storage.grants.set('http://127.0.0.1:8080', { fs: { patterns: [], grantedAt: 1 } })
    const ledger = new GrantLedger(storage)

    ledger.registerApp('http://127.0.0.1:8080', { ...manifestWith('1.0.0'), capabilities: { fs: { quotaBytes: 1 } } })

    expect(ledger.currentGrant('http://127.0.0.1:8080', 'fs')).toBeUndefined()
  })
})

// Same discipline as registerApp's and acknowledgeRollback's own
// persist-failure suites (grant-ledger.test.ts): the in-memory grant/revoke
// happens unconditionally and first, and a write failure is surfaced rather
// than swallowed -- silence here would let a revoked grant reappear on the
// very next restart with nothing reported.
describe('GrantLedger -- a grant/revoke persist failure still applies in-memory, and throws', () => {
  it('grant still applies in-memory even though the write threw', () => {
    const ledger = new GrantLedger(throwingGrantsLedgerStorage())
    ledger.registerApp(APP, { ...manifestWith('1.0.0'), capabilities: { fs: { quotaBytes: 1 } } })

    expect(() => { ledger.grant(APP, 'fs', [], 1) }).toThrow()

    expect(ledger.currentGrant(APP, 'fs')).toBeDefined()
  })

  it('grant throws the underlying error rather than swallowing it', () => {
    const ledger = new GrantLedger(throwingGrantsLedgerStorage())
    ledger.registerApp(APP, { ...manifestWith('1.0.0'), capabilities: { fs: { quotaBytes: 1 } } })

    expect(() => { ledger.grant(APP, 'fs', [], 1) })
      .toThrow(expect.objectContaining({ code: 'ENOSPC' }))
  })

  it('revoke still applies in-memory even though the write threw', () => {
    const ledger = new GrantLedger(throwingGrantsLedgerStorage())
    ledger.registerApp(APP, { ...manifestWith('1.0.0'), capabilities: { fs: { quotaBytes: 1 } } })
    expect(() => { ledger.grant(APP, 'fs', [], 1) }).toThrow() // grant() itself also throws (see above); the in-memory grant still landed
    const id = ledger.currentGrant(APP, 'fs')!.id

    expect(() => { ledger.revoke(APP, id) }).toThrow()

    expect(ledger.currentGrant(APP, 'fs')).toBeUndefined()
  })

  it('granting on a non-persistable origin never reaches the write, so it cannot throw at all', () => {
    const ledger = new GrantLedger(throwingLedgerStorage())
    ledger.registerApp('http://localhost:3000', { ...manifestWith('1.0.0'), capabilities: { fs: { quotaBytes: 1 } } })

    expect(() => { ledger.grant('http://localhost:3000', 'fs', [], 1) }).not.toThrow()
  })
})

// forgetOrigin (A60's escape hatch) is also the "remove this app" primitive's
// building block for the state this file owns -- ADR-0009's 2026-09-04
// amendment: unlike a plain revoke, forgetting an origin drops everything,
// including any persisted grants, so they do not reappear on the next
// restart.
describe('GrantLedger -- forgetOrigin also deletes persisted grants (A23/ADR-0009)', () => {
  it('deletes the persisted grants, so a fresh GrantLedger (simulating a restart) restores nothing', () => {
    const storage = memoryLedgerStorage()
    const before = new GrantLedger(storage)
    before.registerApp(APP, { ...manifestWith('1.0.0'), capabilities: { fs: { quotaBytes: 1 } } })
    before.grant(APP, 'fs', [], 1)

    before.forgetOrigin(APP)

    const after = new GrantLedger(storage) // the "restart"
    after.registerApp(APP, { ...manifestWith('1.0.0'), capabilities: { fs: { quotaBytes: 1 } } })
    expect(after.currentGrant(APP, 'fs')).toBeUndefined()
  })

  it('does not disturb a different origin\'s persisted grants', () => {
    const storage = memoryLedgerStorage()
    const ledger = new GrantLedger(storage)
    ledger.registerApp(APP, { ...manifestWith('1.0.0'), capabilities: { fs: { quotaBytes: 1 } } })
    ledger.grant(APP, 'fs', [], 1)
    ledger.registerApp('https://other.example', { ...manifestWith('1.0.0'), capabilities: { fs: { quotaBytes: 1 } } })
    ledger.grant('https://other.example', 'fs', [], 2)

    ledger.forgetOrigin(APP)

    expect(storage.grants.has(APP)).toBe(false)
    expect(storage.grants.has('https://other.example')).toBe(true)
  })

  it('does not throw when no LedgerStorage was ever supplied', () => {
    const ledger = new GrantLedger()
    ledger.registerApp(APP, { ...manifestWith('1.0.0'), capabilities: { fs: { quotaBytes: 1 } } })
    ledger.grant(APP, 'fs', [], 1)

    expect(() => { ledger.forgetOrigin(APP) }).not.toThrow()
  })

  it('leaves the in-memory grants intact when the on-disk grants delete fails', () => {
    const storage = memoryLedgerStorage()
    const failing: LedgerStorage = { ...storage, deleteGrants: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) } }
    const ledger = new GrantLedger(failing)
    ledger.registerApp(APP, { ...manifestWith('1.0.0'), capabilities: { fs: { quotaBytes: 1 } } })
    ledger.grant(APP, 'fs', [], 1)

    ledger.forgetOrigin(APP)

    expect(ledger.grantsFor(APP)).toHaveLength(1)
  })
})

// C-01/C-02 (docs/open-questions.md): the whole point of persisting the
// origin and the manifest. Before this, a grant survived a restart but was
// INVISIBLE -- the on-disk key is sha256(origin), one-way, and nothing could
// turn the set of grant directories back into a set of origins. The settings
// permissions list was therefore empty on every launch until the app happened
// to be opened, while the grant was live the whole time.
describe('a persisted grant is visible to a brand-new broker, before any app is opened', () => {
  it('survives a restart AND can be enumerated and named', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orivon-grants-'))
    try {
      const manifest: Manifest = { ...manifestWith('1.0.0'), capabilities: { net: { tcp: { connect: ['a.example:443'] } } } }

      const first = createBroker({ ...baseDeps(), ledgerStorage: nodeLedgerStorage(dir) })
      first.registerApp(APP, manifest)
      await first.grant(APP, 'tcp.connect', ['a.example:443'])

      // A genuinely separate broker over the same directory -- the restart.
      const second = createBroker({ ...baseDeps(), ledgerStorage: nodeLedgerStorage(dir) })

      // Nothing has opened the app. This is the assertion that used to fail.
      expect(second.app.registeredOriginsSync()).toContain(APP)
      expect(second.app.isRegisteredSync(APP)).toBe(true)
      await expect(second.app.manifest(APP)).resolves.toMatchObject({ name: manifest.name })
      const restored = await second.app.grants(APP)
      expect(restored.map((g) => g.capability)).toEqual(['tcp.connect'])
      expect(restored[0]?.patterns).toEqual(['a.example:443'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a tampered grants.json naming a DIFFERENT origin is not listed -- the stored name must re-hash to its own directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orivon-grants-'))
    try {
      const manifest: Manifest = { ...manifestWith('1.0.0'), capabilities: { net: { tcp: { connect: ['a.example:443'] } } } }
      const first = createBroker({ ...baseDeps(), ledgerStorage: nodeLedgerStorage(dir) })
      first.registerApp(APP, manifest)
      await first.grant(APP, 'tcp.connect', ['a.example:443'])

      // Rewrite the record to claim someone else's origin, leaving it in the
      // directory named for the real one. Naming a directory that matches the
      // claim would need a sha256 preimage.
      const dirName = originHash(APP)
      const file = join(dir, 'grants', dirName, 'grants.json')
      const onDisk = JSON.parse(readFileSync(file, 'utf8')) as { origin: string }
      writeFileSync(file, JSON.stringify({ ...onDisk, origin: 'https://bank.example' }))

      const storage = nodeLedgerStorage(dir)
      expect(storage.listPersistedOrigins()).not.toContain('https://bank.example')
      expect(storage.listPersistedOrigins()).not.toContain(APP)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
