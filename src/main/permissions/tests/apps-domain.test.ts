import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InternalCaller } from '../../pages/internal-ipc.js'
import { appsDomain } from '../apps-domain.js'
import { appRootDirectoryName } from '../../../loader/index.js'

const CALLER = {} as InternalCaller

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'orivon-apps-domain-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const APP = { origin: 'https://app.example', appName: 'App', rows: [], pickedPathRows: [] }

function setup (): { call: (command: unknown) => Promise<unknown>, permissions: Record<'list' | 'revokeCapability' | 'revokePickedPath', ReturnType<typeof vi.fn>> } {
  const permissions = { list: vi.fn(async () => [APP]), revokeCapability: vi.fn(async () => {}), revokePickedPath: vi.fn(async () => {}) }
  const domain = appsDomain({ permissions, userDataPath: dir, identity: async () => 'session-only' })
  return { call: async (command) => await domain.handle(command, CALLER), permissions }
}

describe('the apps domain', () => {
  it('is for Settings only', () => {
    expect(appsDomain({ permissions: {} as never, userDataPath: dir, identity: async () => 'keychain' }).pages).toEqual(['settings'])
  })

  it('lists the apps with what each has stored, and where the identity key is kept', async () => {
    const root = join(dir, 'apps', appRootDirectoryName(APP.origin))
    await mkdir(join(root, 'files'), { recursive: true })
    await mkdir(join(root, 'code'), { recursive: true })
    await writeFile(join(root, 'files', 'a.txt'), 'x'.repeat(100))
    await writeFile(join(root, 'code', 'index.js'), 'y'.repeat(30))
    const { call } = setup()
    expect(await call({ type: 'list' })).toEqual({ apps: [{ ...APP, storage: { filesBytes: 100, filesQuotaBytes: undefined, codeBytes: 30, codeVersion: undefined } }], identity: 'session-only' })
  })

  it('takes back a permission or a picked path for an origin and a name that are what they should be', async () => {
    const { call, permissions } = setup()
    expect(await call({ type: 'revoke', origin: 'https://app.example', capability: 'fs' })).toEqual({ ok: true })
    expect(await call({ type: 'revokePickedPath', origin: 'https://app.example', pickId: 'pick-1' })).toEqual({ ok: true })
    expect(permissions.revokeCapability).toHaveBeenCalledWith('https://app.example', 'fs')
    expect(permissions.revokePickedPath).toHaveBeenCalledWith('https://app.example', 'pick-1')
  })

  it('refuses an origin that is not the canonical origin of an address, a capability that does not exist, and a pick with no id', async () => {
    const { call, permissions } = setup()
    for (const origin of ['https://app.example/path', 'not a url', 'HTTPS://APP.EXAMPLE', '', 5, null, undefined]) {
      expect(await call({ type: 'revoke', origin, capability: 'fs' }), String(origin)).toEqual({ ok: false })
      expect(await call({ type: 'revokePickedPath', origin, pickId: 'p' }), String(origin)).toEqual({ ok: false })
    }
    for (const capability of ['everything', '', 3, null, { toString: () => 'fs' }]) expect(await call({ type: 'revoke', origin: 'https://app.example', capability })).toEqual({ ok: false })
    for (const pickId of ['', 5, null]) expect(await call({ type: 'revokePickedPath', origin: 'https://app.example', pickId })).toEqual({ ok: false })
    expect(permissions.revokeCapability).not.toHaveBeenCalled()
    expect(permissions.revokePickedPath).not.toHaveBeenCalled()
  })

  it('answers nothing to what it does not know', async () => {
    const { call } = setup()
    expect(await call({ type: 'forget-everything' })).toBeUndefined()
    expect(await call(null)).toBeUndefined()
  })
})
