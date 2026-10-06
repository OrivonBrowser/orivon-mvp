import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Broker } from '../../../broker/broker-contracts.js'
import { MAX_MANIFEST_BYTES } from '../../../loader/manifest/manifest.js'
import { grantLocalFile, readFolderManifest } from '../local-file-grant.js'
import type { LocalFileGrantDeps } from '../local-file-grant.js'

const manifestWith = (capabilities: object): string => JSON.stringify({ orivonApiVersion: 0, id: 'dev.example.notes', name: 'Notes', version: '1.0.0', entry: 'index.html', capabilities })

let dir: string
let key: string
let hint: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orivon-local-grant-'))
  await mkdir(join(dir, 'notes', 'sub'), { recursive: true })
  await writeFile(join(dir, 'notes', 'app.html'), '<p>x</p>')
  key = pathToFileURL(join(dir, 'notes', 'app.html')).href
  hint = pathToFileURL(join(dir, 'notes', 'orivon.json')).href
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

interface Rig { deps: LocalFileGrantDeps, broker: Broker, consent: ReturnType<typeof vi.fn>, records: Set<string>, grants: Array<{ id: string, capability: string, patterns: readonly string[] }>, revokePersisted: ReturnType<typeof vi.fn>, registerApp: ReturnType<typeof vi.fn> }

function rig (over: { recorded?: boolean, answer?: boolean, held?: Array<{ capability: string, patterns: readonly string[] }>, persisted?: Record<string, unknown>, registered?: boolean, addFails?: boolean } = {}): Rig {
  const records = new Set<string>(over.recorded === true ? [key] : [])
  const grants = (over.held ?? []).map((entry, index) => ({ id: `g${String(index)}`, ...entry }))
  const revokePersisted = vi.fn(async (_origin: string, capability: string) => { const at = grants.findIndex((grant) => grant.capability === capability); if (at >= 0) grants.splice(at, 1); return true })
  const registerApp = vi.fn(async () => {})
  const broker = {
    registerApp,
    grant: vi.fn(async (_origin: string, capability: string, patterns: readonly string[]) => {
      const at = grants.findIndex((grant) => grant.capability === capability)
      if (at >= 0) grants.splice(at, 1)
      grants.push({ id: `n${String(grants.length)}`, capability, patterns })
      return {}
    }),
    declinedCapabilitiesFor: async () => undefined,
    clearDeclinedConsent: vi.fn(async () => {}),
    revokePersisted,
    revokeUserSelectedPath: vi.fn(async () => true),
    app: {
      isRegisteredSync: () => over.registered === true,
      grants: async () => grants,
      persistedAppsSync: () => over.persisted === undefined ? [] : [{ origin: key, appName: 'Notes', grants: over.persisted, pickedPaths: {} }]
    }
  } as unknown as Broker
  const consent = vi.fn(async () => over.answer ?? true)
  const deps: LocalFileGrantDeps = {
    broker,
    records: { has: (candidate) => records.has(candidate), add: (candidate) => { if (over.addFails === true) return false; records.add(candidate); return true } },
    consent,
    refused: new Set<string>()
  }
  return { deps, broker, consent, records, grants, revokePersisted, registerApp }
}

describe('readFolderManifest', () => {
  it('reads a manifest beside the document and one in a folder under it', async () => {
    await writeFile(join(dir, 'notes', 'orivon.json'), '{"a":1}')
    await writeFile(join(dir, 'notes', 'sub', 'm.json'), '{"b":2}')
    expect(await readFolderManifest(key, hint)).toEqual({ ok: true, text: '{"a":1}' })
    expect(await readFolderManifest(key, pathToFileURL(join(dir, 'notes', 'sub', 'm.json')).href)).toEqual({ ok: true, text: '{"b":2}' })
  })

  it('refuses a manifest outside the document\'s folder, however the path is written', async () => {
    await writeFile(join(dir, 'secret.json'), '{}')
    expect((await readFolderManifest(key, pathToFileURL(join(dir, 'secret.json')).href)).ok).toBe(false)
    expect((await readFolderManifest(key, `${pathToFileURL(join(dir, 'notes')).href}/../secret.json`)).ok).toBe(false)
  })

  it('refuses a manifest that is a link out of the folder, and a folder that is not there', async () => {
    await writeFile(join(dir, 'secret.json'), '{}')
    await symlink(join(dir, 'secret.json'), join(dir, 'notes', 'orivon.json'))
    const out = await readFolderManifest(key, hint)
    expect(out.ok).toBe(false)
    expect((await readFolderManifest(key, pathToFileURL(join(dir, 'notes', 'nope.json')).href)).ok).toBe(false)
  })

  it('refuses an oversized manifest without reading it whole, a folder, and a hint that is not a local file', async () => {
    await writeFile(join(dir, 'notes', 'orivon.json'), 'x'.repeat(MAX_MANIFEST_BYTES + 1))
    expect(await readFolderManifest(key, hint)).toMatchObject({ ok: false, reason: expect.stringContaining('bytes') })
    expect((await readFolderManifest(key, pathToFileURL(join(dir, 'notes', 'sub')).href)).ok).toBe(false)
    expect((await readFolderManifest(key, 'https://example.com/orivon.json')).ok).toBe(false)
    expect((await readFolderManifest(key, 'file://nas/share/orivon.json')).ok).toBe(false)
  })
})

describe('grantLocalFile', () => {
  const declares = { fs: { quotaBytes: 1000 } }

  async function writeManifest (capabilities: object = declares): Promise<void> {
    await writeFile(join(dir, 'notes', 'orivon.json'), manifestWith(capabilities))
  }

  it('asks once, and on Yes records the file, grants what it declares and says the tab must reload', async () => {
    await writeManifest()
    const r = rig()
    const outcome = await grantLocalFile(r.deps, key, hint)
    expect(outcome).toEqual({ outcome: 'granted-without-install', canonicalOrigin: key, newlyRegistered: true })
    expect(r.consent).toHaveBeenCalledOnce()
    expect(r.consent.mock.calls[0]?.slice(0, 1)).toEqual([key])
    expect(r.records.has(key)).toBe(true)
    expect(r.grants.map((grant) => grant.capability)).toEqual(['fs'])
    expect(r.registerApp).toHaveBeenCalledOnce()
  })

  it('records nothing and grants nothing on No, and does not ask again about the same manifest in this run', async () => {
    await writeManifest()
    const r = rig({ answer: false })
    const outcome = await grantLocalFile(r.deps, key, hint)
    expect(outcome.outcome).toBe('granted-without-install')
    expect(r.records.has(key)).toBe(false)
    expect(r.grants).toEqual([])
    expect(await grantLocalFile(r.deps, key, hint)).toMatchObject({ outcome: 'granted-without-install', newlyRegistered: false })
    expect(r.consent).toHaveBeenCalledOnce()
    expect(r.grants).toEqual([])
  })

  it('asks again after a No when the file now declares something else', async () => {
    await writeManifest()
    const r = rig({ answer: false })
    await grantLocalFile(r.deps, key, hint)
    await writeManifest({ fs: { quotaBytes: 1000 }, id: { curves: ['secp256k1'] } })
    await grantLocalFile(r.deps, key, hint)
    expect(r.consent).toHaveBeenCalledTimes(2)
  })

  it('asks another file with the same manifest on its own, and a Yes after a No still records', async () => {
    await writeManifest()
    const r = rig({ answer: false })
    await grantLocalFile(r.deps, key, hint)
    const other = pathToFileURL(join(dir, 'notes', 'other.html')).href
    await grantLocalFile(r.deps, other, hint)
    expect(r.consent).toHaveBeenCalledTimes(2)
  })

  it('drops the grants and picks a file\'s path persisted without a record, then asks', async () => {
    await writeManifest()
    const r = rig({ held: [{ capability: 'fs', patterns: ['*'] }], persisted: { fs: {} } })
    await grantLocalFile(r.deps, key, hint)
    expect(r.revokePersisted).toHaveBeenCalledWith(key, 'fs')
    expect(r.consent).toHaveBeenCalledOnce()
    expect(r.consent.mock.calls[0]?.[3]).toEqual([])
  })

  it('asks nothing of a recorded file that holds all it declares, and still registers it from the fresh manifest', async () => {
    await writeManifest()
    const r = rig({ recorded: true, held: [{ capability: 'fs', patterns: [] }] })
    // What is held equals what is declared once the broker hydrates it: the same patterns come back from the manifest.
    const outcome = await grantLocalFile(r.deps, key, hint)
    expect(r.registerApp).toHaveBeenCalledOnce()
    expect(r.revokePersisted).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ outcome: 'granted-without-install', newlyRegistered: true })
    expect(r.consent).not.toHaveBeenCalled()
  })

  it('does not say to reload for a recorded file that was already registered this run', async () => {
    await writeManifest()
    const r = rig({ recorded: true, registered: true, held: [{ capability: 'fs', patterns: [] }] })
    expect(await grantLocalFile(r.deps, key, hint)).toMatchObject({ newlyRegistered: false })
  })

  it('asks again when a recorded file now declares a capability it does not hold, and keeps what it held when the answer is No', async () => {
    await writeManifest({ fs: { quotaBytes: 1000 }, id: { curves: ['secp256k1'] } })
    const r = rig({ recorded: true, answer: false, held: [{ capability: 'fs', patterns: [] }] })
    await grantLocalFile(r.deps, key, hint)
    expect(r.consent).toHaveBeenCalledOnce()
    expect(r.consent.mock.calls[0]?.[3]).toEqual(['fs'])
    expect(r.grants.map((grant) => grant.capability)).toEqual(['fs'])
  })

  it('asks again when a held capability is widened, and a Yes replaces it', async () => {
    await writeManifest({ net: { https: { connect: ['*:*'] } } })
    const r = rig({ recorded: true, held: [{ capability: 'https.connect', patterns: ['api.example.com:443'] }] })
    await grantLocalFile(r.deps, key, hint)
    expect(r.consent).toHaveBeenCalledOnce()
    expect(r.grants.find((grant) => grant.capability === 'https.connect')?.patterns).toEqual(['*:*'])
  })

  it('refuses a manifest the folder rule or the parser refuses, before anything is registered or asked', async () => {
    const r = rig()
    expect(await grantLocalFile(r.deps, key, hint)).toMatchObject({ outcome: 'rejected' })
    await writeFile(join(dir, 'notes', 'orivon.json'), 'not json')
    expect(await grantLocalFile(r.deps, key, hint)).toMatchObject({ outcome: 'rejected' })
    await writeFile(join(dir, 'secret.json'), manifestWith(declares))
    expect(await grantLocalFile(r.deps, key, pathToFileURL(join(dir, 'secret.json')).href)).toMatchObject({ outcome: 'rejected' })
    expect(r.registerApp).not.toHaveBeenCalled()
    expect(r.consent).not.toHaveBeenCalled()
  })

  it('refuses a key that is not a local file', async () => {
    await writeManifest()
    const r = rig()
    expect(await grantLocalFile(r.deps, 'https://example.com', hint)).toMatchObject({ outcome: 'rejected' })
    expect(r.registerApp).not.toHaveBeenCalled()
  })

  it('grants nothing when the record cannot be written, so a grant never outlives its record', async () => {
    await writeManifest()
    const r = rig({ addFails: true })
    expect(await grantLocalFile(r.deps, key, hint)).toMatchObject({ outcome: 'rejected' })
    expect(r.grants).toEqual([])
  })

  it('treats a manifest with no capability as nothing to ask', async () => {
    await writeManifest({})
    const r = rig()
    expect(await grantLocalFile(r.deps, key, hint)).toMatchObject({ outcome: 'granted-without-install' })
    expect(r.consent).not.toHaveBeenCalled()
    expect(r.records.has(key)).toBe(false)
  })

  it('ignores the answer of a prompt for a tab that moved on, and records nothing', async () => {
    await writeManifest()
    const r = rig()
    const caller = { stillOn: vi.fn(() => false) } as never
    expect(await grantLocalFile(r.deps, key, hint, caller)).toMatchObject({ outcome: 'granted-without-install' })
    expect(r.records.has(key)).toBe(false)
    expect(r.grants).toEqual([])
  })
})
