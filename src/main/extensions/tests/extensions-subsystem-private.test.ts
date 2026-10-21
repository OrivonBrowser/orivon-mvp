import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// afterReady in a private runtime: the extensions of its own registry (the copy it was given) load, the
// Web Store page's APIs are still served (so a store tab never reaches the native ones) with installs
// refused, every install route refuses, and removing or turning off an extension is refused. The ordinary
// runtime is the control.
const loadExtension = vi.fn(async () => ({}))
const startWebStore = vi.fn(async () => ({
  installFromStore: vi.fn(), checkForUpdates: vi.fn(), updateFromStore: vi.fn()
}))
const installApis = vi.fn()
let published: any
let startsNew = false
const seedBundledExtensions = vi.fn(async () => {})

vi.mock('electron', () => ({ session: { defaultSession: { extensions: { loadExtension } } } }))
vi.mock('../extension-host.js', () => ({ createExtensionHost: () => ({ getRouter: () => ({}) }), extensionPagesAroundReload: {} }))
vi.mock('../extensions-dnr.js', () => ({ attachExtensionsDnr: vi.fn(), getDnrEngine: vi.fn() }))
vi.mock('../dnr-api.js', () => ({ registerDnrApiHandlers: () => ({ onRuleMatched: vi.fn(), onTabNavigated: vi.fn() }) }))
vi.mock('../dnr-webrequest.js', () => ({ installDnrWebRequestHandlers: vi.fn() }))
vi.mock('../extension-known-permissions.js', () => ({ installExtensionPermissionWarningFilter: vi.fn() }))
vi.mock('../extension-install-prompt.js', () => ({ createExtensionInstallPrompt: () => vi.fn(async () => true) }))
vi.mock('../store-runner.js', () => ({ startWebStore }))
vi.mock('../store-test-hook.js', () => ({ installStoreTestHook: vi.fn() }))
vi.mock('../extensions-install-test-hook.js', () => ({ installExtensionsInstallTestHook: vi.fn() }))
vi.mock('../api/install-apis.js', () => ({ installApis }))
vi.mock('../side-panel-runner.js', () => ({ closeSidePanels: vi.fn(async () => {}) }))
vi.mock('../install-extension-commands.js', () => ({ installExtensionCommands: () => ({ whenReady: async () => {}, getAll: () => [] }) }))
vi.mock('../registry-runner.js', () => ({ readRegistry: () => [{ id: 'a'.repeat(32), name: 'x', enabled: true, path: '/slot/1' }] }))
vi.mock('../../default-profile/profile-start.js', () => ({ startsFromDefaultProfile: () => startsNew }))
vi.mock('../seed-bundled.js', () => ({ seedBundledExtensions }))
vi.mock('../../default-profile/default-profile-dir.js', () => ({ currentDefaultProfileDir: () => '/default-profile' }))
vi.mock('../../registry.js', () => ({ publishExtensions: (_ctx: unknown, api: unknown) => { published = api } }))

const { extensionsSubsystem } = await import('../extensions-subsystem.js')

let profile = '/profile'

function ctx (privateSession: boolean): any {
  return { privateSession, app: { getPath: () => profile } }
}

const REFUSED = { installed: false, reason: 'Extensions cannot be added in a private window. Add them in a normal window.' }

beforeEach(() => {
  loadExtension.mockClear()
  startWebStore.mockClear()
  installApis.mockClear()
  seedBundledExtensions.mockClear()
  startsNew = false
  published = undefined
  profile = '/profile'
})

afterEach(() => { if (profile !== '/profile') rmSync(profile, { recursive: true, force: true }) })

describe('extensionsSubsystem.afterReady', () => {
  it('in a private runtime loads its own registry, starts the store with installs refused and refuses every install route', async () => {
    await extensionsSubsystem.afterReady!(ctx(true))
    expect(loadExtension).toHaveBeenCalledTimes(1)
    expect(startWebStore).toHaveBeenCalledTimes(1)
    expect((startWebStore.mock.calls[0] as any[])[0].privateSession).toBe(true)
    await expect(published.installFromFolder('/x')).resolves.toEqual(REFUSED)
    await expect(published.installFromFile('/x.crx')).resolves.toEqual(REFUSED)
    await expect(published.installFromStore('a'.repeat(32))).resolves.toEqual(REFUSED)
    await expect(published.updateFromStore('a'.repeat(32))).resolves.toEqual(REFUSED)
  })

  it('refuses to remove or turn off an extension in a private runtime', async () => {
    await extensionsSubsystem.afterReady!(ctx(true))
    await expect(published.uninstall('a'.repeat(32))).rejects.toThrow('changed in a normal window')
    await expect(published.setEnabled('a'.repeat(32), false)).rejects.toThrow('changed in a normal window')
  })

  it('starts the preferences of a private runtime from the copy it was given, and keeps later changes in memory', async () => {
    profile = mkdtempSync(join(tmpdir(), 'orivon-subsystem-private-'))
    mkdirSync(join(profile, 'extensions'), { recursive: true })
    const file = join(profile, 'extensions', 'prefs.json')
    const before = JSON.stringify({ version: 1, extensions: { x: { pinned: true, privateWindows: true } } })
    writeFileSync(file, before)
    await extensionsSubsystem.afterReady!(ctx(true))
    expect(installApis).toHaveBeenCalledTimes(1)
    const prefs = installApis.mock.calls[0]![0].prefs
    expect(prefs.get('x').pinned).toBe(true)
    prefs.update('x', { pinned: false })
    await prefs.flush()
    expect(prefs.get('x').pinned).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('in an ordinary runtime loads the enabled extensions and starts the Web Store', async () => {
    await extensionsSubsystem.afterReady!(ctx(false))
    expect(loadExtension).toHaveBeenCalledTimes(1)
    expect(startWebStore).toHaveBeenCalledTimes(1)
    expect(installApis).toHaveBeenCalledTimes(1)
  })

  it('seeds the bundled extensions into an ordinary profile that starts from the default profile, and into no other', async () => {
    startsNew = true
    await extensionsSubsystem.afterReady!(ctx(false))
    expect(seedBundledExtensions).toHaveBeenCalledTimes(1)
    expect(seedBundledExtensions.mock.calls[0]).toEqual([expect.objectContaining({ userDataPath: '/profile' }), '/default-profile'])

    seedBundledExtensions.mockClear()
    startsNew = false
    await extensionsSubsystem.afterReady!(ctx(false))
    expect(seedBundledExtensions).not.toHaveBeenCalled()
  })

  it('seeds nothing in a private runtime', async () => {
    startsNew = true
    await extensionsSubsystem.afterReady!(ctx(true))
    expect(seedBundledExtensions).not.toHaveBeenCalled()
  })
})
