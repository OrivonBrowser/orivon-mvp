import { beforeEach, describe, expect, it, vi } from 'vitest'

// afterReady in a private or guest runtime: nothing loads, the Web Store page's APIs are still
// served (so a store tab never reaches the native ones) with installs refused, and every install
// route refuses. The ordinary runtime is the control.
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

function ctx (privateSession: boolean): any {
  return { privateSession, app: { getPath: () => '/profile' } }
}

const REFUSED = { installed: false, reason: 'Extensions are not available in a private or guest window.' }

beforeEach(() => {
  loadExtension.mockClear()
  startWebStore.mockClear()
  installApis.mockClear()
  seedBundledExtensions.mockClear()
  startsNew = false
  published = undefined
})

describe('extensionsSubsystem.afterReady', () => {
  it('in a private runtime loads nothing, starts the store with installs refused and refuses every install route', async () => {
    await extensionsSubsystem.afterReady!(ctx(true))
    expect(loadExtension).not.toHaveBeenCalled()
    expect(startWebStore).toHaveBeenCalledTimes(1)
    expect((startWebStore.mock.calls[0] as any[])[0].privateSession).toBe(true)
    await expect(published.installFromFolder('/x')).resolves.toEqual(REFUSED)
    await expect(published.installFromFile('/x.crx')).resolves.toEqual(REFUSED)
    await expect(published.installFromStore('a'.repeat(32))).resolves.toEqual(REFUSED)
    await expect(published.updateFromStore('a'.repeat(32))).resolves.toEqual(REFUSED)
  })

  it('keeps the preferences in memory in a private runtime', async () => {
    await extensionsSubsystem.afterReady!(ctx(true))
    expect(installApis).toHaveBeenCalledTimes(1)
    const prefs = installApis.mock.calls[0]![0].prefs
    prefs.update('x', { pinned: true })
    expect(prefs.get('x').pinned).toBe(true)
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
