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

const NO_DEVICES = { rows: () => [], forget: () => false }
const DEVICE = { key: 'k1', label: 'Nano X (USB 2c97:4011)' }

function setup (devices: Parameters<typeof appsDomain>[0]['devices'] = NO_DEVICES): { call: (command: unknown) => Promise<unknown>, permissions: Record<'list' | 'revokeCapability' | 'revokePickedPath', ReturnType<typeof vi.fn>> } {
  const permissions = { list: vi.fn(async () => [APP]), revokeCapability: vi.fn(async () => {}), revokePickedPath: vi.fn(async () => {}) }
  const domain = appsDomain({ permissions, devices, userDataPath: dir, identity: async () => 'session-only' })
  return { call: async (command) => await domain.handle(command, CALLER), permissions }
}

describe('the apps domain', () => {
  it('is for Settings only', () => {
    expect(appsDomain({ permissions: {} as never, devices: NO_DEVICES, userDataPath: dir, identity: async () => 'keychain' }).pages).toEqual(['settings'])
  })

  it('lists the apps with what each has stored, and where the identity key is kept', async () => {
    const root = join(dir, 'apps', appRootDirectoryName(APP.origin))
    await mkdir(join(root, 'files'), { recursive: true })
    await mkdir(join(root, 'code'), { recursive: true })
    await writeFile(join(root, 'files', 'a.txt'), 'x'.repeat(100))
    await writeFile(join(root, 'code', 'index.js'), 'y'.repeat(30))
    const { call } = setup()
    expect(await call({ type: 'list' })).toEqual({ apps: [{ ...APP, deviceRows: [], storage: { filesBytes: 100, filesQuotaBytes: undefined, codeBytes: 30, codeVersion: undefined } }], identity: 'session-only' })
  })

  it('takes back a permission or a picked path for an origin and a name that are what they should be', async () => {
    const { call, permissions } = setup()
    expect(await call({ type: 'revoke', origin: 'https://app.example', capability: 'fs' })).toEqual({ ok: true })
    expect(await call({ type: 'revokePickedPath', origin: 'https://app.example', pickId: 'pick-1' })).toEqual({ ok: true })
    expect(permissions.revokeCapability).toHaveBeenCalledWith('https://app.example', 'fs')
    expect(permissions.revokePickedPath).toHaveBeenCalledWith('https://app.example', 'pick-1')
  })

  it('lists each app with the devices the person approved for it', async () => {
    const { call } = setup({ rows: (origin) => origin === 'https://app.example' ? [DEVICE] : [], forget: () => false })
    expect(await call({ type: 'list' })).toMatchObject({ apps: [{ origin: 'https://app.example', deviceRows: [DEVICE] }] })
  })

  it('forgets one approved device for an origin that is what it should be, and refuses the rest', async () => {
    const forget = vi.fn(() => true)
    const { call } = setup({ rows: () => [], forget })
    expect(await call({ type: 'forgetDevice', origin: 'https://app.example', key: 'k1' })).toEqual({ ok: true })
    expect(forget).toHaveBeenCalledWith('https://app.example', 'k1')
    forget.mockClear()
    for (const request of [{ origin: 'https://app.example/path', key: 'k1' }, { origin: 'https://app.example', key: '' }, { origin: 'https://app.example', key: 3 }, { origin: 5, key: 'k1' }]) {
      expect(await call({ type: 'forgetDevice', ...request })).toEqual({ ok: false })
    }
    expect(forget).not.toHaveBeenCalled()
  })

  it('takes back each media permission, which are capability kinds like the rest', async () => {
    const { call, permissions } = setup()
    for (const capability of ['media.camera', 'media.microphone', 'media.screen']) {
      expect(await call({ type: 'revoke', origin: 'https://app.example', capability })).toEqual({ ok: true })
      expect(permissions.revokeCapability).toHaveBeenCalledWith('https://app.example', capability)
    }
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
