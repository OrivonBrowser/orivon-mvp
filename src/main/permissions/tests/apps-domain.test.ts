import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InternalCaller } from '../../pages/internal-ipc.js'
import { appsDomain } from '../apps-domain.js'
import { appRootDirectoryName } from '../../../loader/index.js'
import { SchemeChoices } from '../../scheme-routing/scheme-choices.js'

const CALLER = {} as InternalCaller

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'orivon-apps-domain-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const APP = { origin: 'https://app.example', appName: 'App', rows: [], pickedPathRows: [] }

const NO_DEVICES = { rows: () => [], forget: () => false }
const DEVICE = { key: 'k1', label: 'Nano X (USB 2c97:4011)' }

const NO_ROUTES = { stateOf: () => 'off' as const, blockedFor: () => undefined, set: () => {} }

function setup (devices: Parameters<typeof appsDomain>[0]['devices'] = NO_DEVICES, links = new SchemeChoices(null), routes: Parameters<typeof appsDomain>[0]['routes'] = NO_ROUTES): { call: (command: unknown) => Promise<unknown>, permissions: Record<'list' | 'revokeCapability' | 'revokePickedPath', ReturnType<typeof vi.fn>> } {
  const permissions = { list: vi.fn(async () => [APP]), revokeCapability: vi.fn(async () => {}), revokePickedPath: vi.fn(async () => {}) }
  const domain = appsDomain({ permissions, devices, links, userDataPath: dir, identity: async () => 'session-only', routes })
  return { call: async (command) => await domain.handle(command, CALLER), permissions }
}

describe('the apps domain', () => {
  it('is for Settings only', () => {
    expect(appsDomain({ permissions: {} as never, devices: NO_DEVICES, links: new SchemeChoices(null), userDataPath: dir, identity: async () => 'keychain', routes: NO_ROUTES }).pages).toEqual(['settings'])
  })

  it('lists the apps with what each has stored, and where the identity key is kept', async () => {
    const root = join(dir, 'apps', appRootDirectoryName(APP.origin))
    await mkdir(join(root, 'files'), { recursive: true })
    await mkdir(join(root, 'code'), { recursive: true })
    await writeFile(join(root, 'files', 'a.txt'), 'x'.repeat(100))
    await writeFile(join(root, 'code', 'index.js'), 'y'.repeat(30))
    const { call } = setup()
    expect(await call({ type: 'list' })).toEqual({ apps: [{ ...APP, deviceRows: [], linkSchemes: [], route: { state: 'off', blocked: undefined }, storage: { filesBytes: 100, filesQuotaBytes: undefined, codeBytes: 30, codeVersion: undefined } }], identity: 'session-only' })
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

  it('lists the kinds of link each app was chosen to open, and lets the person take one back', async () => {
    const links = new SchemeChoices(null)
    links.set('magnet', 'https://app.example')
    links.set('mailto', 'https://mail.example')
    const { call } = setup(NO_DEVICES, links)
    expect(await call({ type: 'list' })).toMatchObject({ apps: [{ origin: 'https://app.example', linkSchemes: ['magnet'] }] })
    expect(await call({ type: 'forgetLink', origin: 'https://app.example', scheme: 'magnet' })).toEqual({ ok: true })
    expect(links.get('magnet')).toBeUndefined()
    expect(links.get('mailto')).toBe('https://mail.example')
  })

  it('forgets a kind of link only for the app it was chosen for, and refuses the rest', async () => {
    const links = new SchemeChoices(null)
    links.set('magnet', 'https://app.example')
    const { call } = setup(NO_DEVICES, links)
    for (const request of [{ origin: 'https://other.example', scheme: 'magnet' }, { origin: 'https://app.example', scheme: 'mailto' }, { origin: 'https://app.example/path', scheme: 'magnet' }, { origin: 'https://app.example', scheme: 5 }, { origin: 5, scheme: 'magnet' }]) {
      expect(await call({ type: 'forgetLink', ...request })).toEqual({ ok: false })
    }
    expect(links.get('magnet')).toBe('https://app.example')
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

describe('the per-app route', () => {
  it('lists what each app\'s route is doing and why it cannot be turned on', async () => {
    const { call } = setup(NO_DEVICES, new SchemeChoices(null), { stateOf: () => 'down', blockedFor: () => 'no-proxy', set: () => {} })
    expect(await call({ type: 'list' })).toMatchObject({ apps: [{ origin: 'https://app.example', route: { state: 'down', blocked: 'no-proxy' } }] })
  })

  it('turns a route on or off for an origin and a switch that are what they should be', async () => {
    const set = vi.fn()
    const { call } = setup(NO_DEVICES, new SchemeChoices(null), { ...NO_ROUTES, set })
    expect(await call({ type: 'setRoute', origin: 'https://app.example', routed: true })).toEqual({ ok: true })
    expect(await call({ type: 'setRoute', origin: 'https://app.example', routed: false })).toEqual({ ok: true })
    expect(set.mock.calls).toEqual([['https://app.example', true], ['https://app.example', false]])
  })

  it('refuses a request that is not for a canonical origin or does not say on or off', async () => {
    const set = vi.fn()
    const { call } = setup(NO_DEVICES, new SchemeChoices(null), { ...NO_ROUTES, set })
    for (const request of [{ origin: 'https://app.example/path', routed: true }, { origin: 5, routed: true }, { origin: 'https://app.example', routed: 'yes' }, { origin: 'https://app.example' }]) {
      expect(await call({ type: 'setRoute', ...request })).toEqual({ ok: false })
    }
    expect(set).not.toHaveBeenCalled()
  })

  it('will not turn a route on that is blocked, but always turns one off', async () => {
    const set = vi.fn()
    const { call } = setup(NO_DEVICES, new SchemeChoices(null), { stateOf: () => 'off', blockedFor: () => 'not-cached', set })
    expect(await call({ type: 'setRoute', origin: 'https://app.example', routed: true })).toEqual({ ok: false })
    expect(await call({ type: 'setRoute', origin: 'https://app.example', routed: false })).toEqual({ ok: true })
    expect(set.mock.calls).toEqual([['https://app.example', false]])
  })
})
