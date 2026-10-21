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

const NO_ROUTES: Parameters<typeof appsDomain>[0]['routes'] = { stateOf: () => 'off' as const, kindOf: () => null, unreadable: () => false, blockedFor: () => undefined, set: () => {} }

const FS_ROW = { capability: 'fs' as const, on: true, canTurnOn: true, warning: false, message: 'Store files in a private folder for this app on this device', patterns: [] }

function setup (devices: Parameters<typeof appsDomain>[0]['devices'] = NO_DEVICES, links = new SchemeChoices(null), routes: Parameters<typeof appsDomain>[0]['routes'] = NO_ROUTES): { call: (command: unknown) => Promise<unknown>, permissions: Record<'list' | 'revokePickedPath', ReturnType<typeof vi.fn>>, switches: Record<'rowsFor' | 'set' | 'idleApps', ReturnType<typeof vi.fn>> } {
  const permissions = { list: vi.fn(async () => [APP]), revokePickedPath: vi.fn(async () => {}) }
  const switches = { rowsFor: vi.fn(async () => [FS_ROW]), idleApps: vi.fn(async () => []), set: vi.fn(async (): Promise<'ok' | 'stale'> => 'ok') }
  const domain = appsDomain({ permissions, switches, devices, links, userDataPath: dir, identity: async () => 'session-only', routes })
  return { call: async (command) => await domain.handle(command, CALLER), permissions, switches }
}

describe('the apps domain', () => {
  it('is for Settings only', () => {
    expect(appsDomain({ permissions: {} as never, switches: {} as never, devices: NO_DEVICES, links: new SchemeChoices(null), userDataPath: dir, identity: async () => 'keychain', routes: NO_ROUTES }).pages).toEqual(['settings'])
  })

  it('lists the apps with what each has stored, and where the identity key is kept', async () => {
    const root = join(dir, 'apps', appRootDirectoryName(APP.origin))
    await mkdir(join(root, 'files'), { recursive: true })
    await mkdir(join(root, 'code'), { recursive: true })
    await writeFile(join(root, 'files', 'a.txt'), 'x'.repeat(100))
    await writeFile(join(root, 'code', 'index.js'), 'y'.repeat(30))
    const { call } = setup()
    expect(await call({ type: 'list' })).toEqual({ apps: [{ origin: APP.origin, appName: APP.appName, pickedPathRows: [], capabilityRows: [FS_ROW], deviceRows: [], linkSchemes: [], route: { state: 'off', via: null, blocked: {}, unreadable: false }, storage: { filesBytes: 100, filesQuotaBytes: undefined, codeBytes: 30, codeVersion: undefined } }], identity: 'session-only' })
  })

  it('takes back a picked path for an origin and a name that are what they should be', async () => {
    const { call, permissions } = setup()
    expect(await call({ type: 'revokePickedPath', origin: 'https://app.example', pickId: 'pick-1' })).toEqual({ ok: true })
    expect(permissions.revokePickedPath).toHaveBeenCalledWith('https://app.example', 'pick-1')
  })

  it('tells the chrome after it took a picked path away, because the key counts picked paths', async () => {
    const changed = vi.fn()
    const domain = appsDomain({ permissions: { list: async () => [], revokePickedPath: async () => {} }, switches: { rowsFor: async () => [], idleApps: async () => [], set: async () => 'ok' }, devices: NO_DEVICES, links: new SchemeChoices(null), userDataPath: dir, identity: async () => 'session-only', routes: NO_ROUTES, changed })
    await domain.handle({ type: 'revokePickedPath', origin: 'https://app.example', pickId: 'pick-1' }, CALLER)
    expect(changed).toHaveBeenCalledTimes(1)
    await domain.handle({ type: 'revokePickedPath', origin: 'https://app.example', pickId: '' }, CALLER)
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('adds the apps that hold nothing and remember a refusal to the list, which the grant list leaves out', async () => {
    const { call, switches } = setup()
    switches.idleApps.mockResolvedValueOnce([{ origin: 'https://idle.example', appName: 'Idle' }])
    const reply = await call({ type: 'list' }) as { apps: Array<{ origin: string, capabilityRows: unknown[], pickedPathRows: unknown[] }> }
    expect(switches.idleApps).toHaveBeenCalledWith(new Set(['https://app.example']))
    expect(reply.apps.map((app) => app.origin)).toEqual(['https://app.example', 'https://idle.example'])
    expect(reply.apps[1]).toMatchObject({ appName: 'Idle', pickedPathRows: [] })
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

  it('switches each capability, media ones included, off without patterns and on with the patterns the row offered', async () => {
    const { call, switches } = setup()
    for (const capability of ['media.camera', 'media.microphone', 'media.screen']) {
      expect(await call({ type: 'setCapability', origin: 'https://app.example', capability, on: false, patterns: ['ignored'] })).toEqual({ ok: true })
      expect(switches.set).toHaveBeenLastCalledWith('https://app.example', capability, false, [])
    }
    expect(await call({ type: 'setCapability', origin: 'https://app.example', capability: 'https.connect', on: true, patterns: ['a.example:443'] })).toEqual({ ok: true })
    expect(switches.set).toHaveBeenLastCalledWith('https://app.example', 'https.connect', true, ['a.example:443'])
  })

  it('says why a switch was not turned on, so the page draws the row again', async () => {
    const { call, switches } = setup()
    switches.set.mockResolvedValueOnce('stale')
    expect(await call({ type: 'setCapability', origin: 'https://app.example', capability: 'fs', on: true, patterns: [] })).toEqual({ ok: false, reason: 'stale' })
  })

  it('refuses an origin that is not the canonical origin of an address, a capability that does not exist, a switch that is not on or off and a pick with no id', async () => {
    const { call, permissions, switches } = setup()
    for (const origin of ['https://app.example/path', 'not a url', 'HTTPS://APP.EXAMPLE', '', 5, null, undefined]) {
      expect(await call({ type: 'setCapability', origin, capability: 'fs', on: false }), String(origin)).toEqual({ ok: false })
      expect(await call({ type: 'revokePickedPath', origin, pickId: 'p' }), String(origin)).toEqual({ ok: false })
    }
    for (const capability of ['everything', '', 3, null, { toString: () => 'fs' }]) expect(await call({ type: 'setCapability', origin: 'https://app.example', capability, on: false })).toEqual({ ok: false })
    for (const on of ['yes', 1, null, undefined]) expect(await call({ type: 'setCapability', origin: 'https://app.example', capability: 'fs', on })).toEqual({ ok: false })
    for (const patterns of ['a', [5], [null], Array.from({ length: 257 }, () => 'a')]) expect(await call({ type: 'setCapability', origin: 'https://app.example', capability: 'fs', on: true, patterns })).toEqual({ ok: false })
    for (const pickId of ['', 5, null]) expect(await call({ type: 'revokePickedPath', origin: 'https://app.example', pickId })).toEqual({ ok: false })
    expect(switches.set).not.toHaveBeenCalled()
    expect(permissions.revokePickedPath).not.toHaveBeenCalled()
  })

  it('answers nothing to what it does not know', async () => {
    const { call } = setup()
    expect(await call({ type: 'forget-everything' })).toBeUndefined()
    expect(await call(null)).toBeUndefined()
  })
})

describe('the per-app route', () => {
  it('lists what each app\'s route is doing, the tunnel it uses and why each tunnel cannot be chosen', async () => {
    const blockedFor = (_origin: string, kind: 'nym' | 'socks5') => kind === 'socks5' ? 'no-proxy' as const : undefined
    const { call } = setup(NO_DEVICES, new SchemeChoices(null), { ...NO_ROUTES, stateOf: () => 'down', kindOf: () => 'nym', blockedFor })
    expect(await call({ type: 'list' })).toMatchObject({ apps: [{ origin: 'https://app.example', route: { state: 'down', via: 'nym', blocked: { socks5: 'no-proxy' }, unreadable: false } }] })
  })

  it('says so when the list of routed apps could not be read', async () => {
    const { call } = setup(NO_DEVICES, new SchemeChoices(null), { ...NO_ROUTES, unreadable: () => true })
    expect(await call({ type: 'list' })).toMatchObject({ apps: [{ route: { unreadable: true } }] })
  })

  it('reports a choice that could not be kept, instead of saying it was made', async () => {
    const { call } = setup(NO_DEVICES, new SchemeChoices(null), { ...NO_ROUTES, set: async () => { throw new Error('disk full') } })
    expect(await call({ type: 'setRoute', origin: 'https://app.example', kind: 'nym' })).toEqual({ ok: false })
  })

  it('sends an app through the tunnel asked for, or through none, for an origin and a choice that are what they should be', async () => {
    const set = vi.fn()
    const { call } = setup(NO_DEVICES, new SchemeChoices(null), { ...NO_ROUTES, set })
    expect(await call({ type: 'setRoute', origin: 'https://app.example', kind: 'nym' })).toEqual({ ok: true })
    expect(await call({ type: 'setRoute', origin: 'https://app.example', kind: 'socks5' })).toEqual({ ok: true })
    expect(await call({ type: 'setRoute', origin: 'https://app.example', kind: null })).toEqual({ ok: true })
    expect(set.mock.calls).toEqual([['https://app.example', 'nym'], ['https://app.example', 'socks5'], ['https://app.example', null]])
  })

  it('refuses a request that is not for a canonical origin or does not name a tunnel or none', async () => {
    const set = vi.fn()
    const { call } = setup(NO_DEVICES, new SchemeChoices(null), { ...NO_ROUTES, set })
    for (const request of [{ origin: 'https://app.example/path', kind: 'nym' }, { origin: 5, kind: 'nym' }, { origin: 'https://app.example', kind: 'tor' }, { origin: 'https://app.example', kind: true }, { origin: 'https://app.example' }]) {
      expect(await call({ type: 'setRoute', ...request })).toEqual({ ok: false })
    }
    expect(set).not.toHaveBeenCalled()
  })

  it('will not send an app through a tunnel that is blocked for it, but always gives one up', async () => {
    const set = vi.fn()
    const { call } = setup(NO_DEVICES, new SchemeChoices(null), { ...NO_ROUTES, blockedFor: (_origin, kind) => kind === 'nym' ? 'nym-off' : 'not-cached', set })
    expect(await call({ type: 'setRoute', origin: 'https://app.example', kind: 'nym' })).toEqual({ ok: false })
    expect(await call({ type: 'setRoute', origin: 'https://app.example', kind: 'socks5' })).toEqual({ ok: false })
    expect(await call({ type: 'setRoute', origin: 'https://app.example', kind: null })).toEqual({ ok: true })
    expect(set.mock.calls).toEqual([['https://app.example', null]])
  })
})
