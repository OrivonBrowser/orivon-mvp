import { beforeEach, describe, expect, it, vi } from 'vitest'

// What `ctx.extensions` does when it is asked before `afterWindow` has loaded the extensions and started the store: every call
// that installs, changes or reloads an extension waits for the tail, then acts; the store methods wait and then answer with
// the store that started, or with a refusal that says why when it could not.
const order: string[] = []
let releaseLoad: () => void = () => {}
const loadExtension = vi.fn(async () => {
  order.push('load:start')
  await new Promise<void>((resolve) => { releaseLoad = resolve })
  order.push('load:end')
  return {}
})
const store = {
  installFromStore: vi.fn(async () => ({ installed: true as const })),
  checkForUpdates: vi.fn(async () => {}),
  updateFromStore: vi.fn(async () => ({ installed: true as const }))
}
const startWebStore = vi.fn(async (..._args: unknown[]) => { order.push('store:started'); return store })
const installFromFolder = vi.fn(async () => { order.push('installFromFolder'); return { installed: true as const } })
const installFromFile = vi.fn(async () => { order.push('installFromFile'); return { installed: true as const } })
const uninstall = vi.fn(async () => { order.push('uninstall') })
const setEnabled = vi.fn(async () => { order.push('setEnabled') })
const applyManifest = vi.fn(async () => { order.push('applyManifest'); return { applied: true } })
let published: any
let storeHook: any

vi.mock('electron', () => ({ session: { defaultSession: { extensions: { loadExtension } } } }))
vi.mock('../extension-host.js', () => ({ createExtensionHost: () => ({ getRouter: () => ({}) }), extensionPagesAroundReload: {} }))
vi.mock('../extensions-dnr.js', () => ({ attachExtensionsDnr: vi.fn(), getDnrEngine: vi.fn() }))
vi.mock('../dnr-api.js', () => ({ registerDnrApiHandlers: () => ({ onRuleMatched: vi.fn(), onTabNavigated: vi.fn() }) }))
vi.mock('../dnr-webrequest.js', () => ({ installDnrWebRequestHandlers: vi.fn() }))
vi.mock('../extension-known-permissions.js', () => ({ installExtensionPermissionWarningFilter: vi.fn() }))
vi.mock('../extension-install-prompt.js', () => ({ createExtensionInstallPrompt: () => vi.fn(async () => true) }))
vi.mock('../store-runner.js', () => ({ startWebStore }))
vi.mock('../store-test-hook.js', () => ({ installStoreTestHook: (hook: unknown) => { storeHook = hook } }))
vi.mock('../extensions-install-test-hook.js', () => ({ installExtensionsInstallTestHook: vi.fn() }))
vi.mock('../api/install-apis.js', () => ({ installApis: vi.fn() }))
vi.mock('../side-panel-runner.js', () => ({ closeSidePanels: vi.fn(async () => {}) }))
vi.mock('../install-extension-commands.js', () => ({ installExtensionCommands: () => ({ whenReady: async () => {}, getAll: () => [] }) }))
vi.mock('../registry-runner.js', () => ({ readRegistry: () => [{ id: 'a'.repeat(32), name: 'x', enabled: true, path: '/slot/1' }] }))
vi.mock('../../default-profile/profile-start.js', () => ({ startsFromDefaultProfile: () => false }))
vi.mock('../seed-bundled.js', () => ({ seedBundledExtensions: vi.fn(async () => {}), refreshBundledExtensions: vi.fn() }))
vi.mock('../../default-profile/default-profile-dir.js', () => ({ currentDefaultProfileDir: () => '/default-profile' }))
vi.mock('../install-runner.js', () => ({ installFromFolder, installFromFile }))
vi.mock('../install-lifecycle.js', () => ({ uninstall, setEnabled }))
vi.mock('../effective-manifest-runner.js', () => ({ createManifestApplier: () => ({ applyAtBoot: vi.fn(), applyManifest }) }))
vi.mock('../../registry.js', () => ({ publishExtensions: (_ctx: unknown, api: unknown) => { published = api } }))

const { extensionsSubsystem } = await import('../extensions-subsystem.js')

const ID = 'a'.repeat(32)
const runtime: any = { privateSession: false, app: { getPath: () => '/profile' } }

/** Lets every promise that can settle settle, so a call that is still waiting has had its chance to act. */
async function flush (): Promise<void> {
  for (let turn = 0; turn < 10; turn++) await Promise.resolve()
}

beforeEach(() => {
  order.length = 0
  published = undefined
  storeHook = undefined
  for (const spy of [loadExtension, startWebStore, installFromFolder, installFromFile, uninstall, setEnabled, applyManifest, ...Object.values(store)]) spy.mockClear()
})

describe('ctx.extensions before the extensions are loaded', () => {
  it('holds every install, change and reload until the tail has loaded the extensions and started the store, then runs it', async () => {
    await extensionsSubsystem.afterReady!(runtime)
    expect(published).toBeDefined()
    expect(loadExtension).not.toHaveBeenCalled()

    const calls = [
      published.installFromFolder('/dir'),
      published.installFromFile('/file.crx'),
      published.uninstall(ID),
      published.setEnabled(ID, false),
      published.applyManifest(ID, 'now'),
      published.installFromStore(ID),
      published.updateFromStore(ID),
      published.checkForUpdates()
    ]
    await flush()
    expect(order).toEqual([])
    for (const spy of [installFromFolder, installFromFile, uninstall, setEnabled, applyManifest, ...Object.values(store)]) expect(spy).not.toHaveBeenCalled()

    const tail = extensionsSubsystem.afterWindow!(runtime)
    await flush()
    // The load is under way and unfinished: nothing a caller asked for has run.
    expect(order).toEqual(['load:start'])
    releaseLoad()
    await tail
    await Promise.all(calls)

    expect(order.slice(0, 3)).toEqual(['load:start', 'load:end', 'store:started'])
    expect(order.slice(3).sort()).toEqual(['applyManifest', 'installFromFile', 'installFromFolder', 'setEnabled', 'uninstall'])
    expect(installFromFolder).toHaveBeenCalledWith(expect.objectContaining({ userDataPath: '/profile' }), '/dir', undefined)
    expect(uninstall).toHaveBeenCalledWith(expect.objectContaining({ userDataPath: '/profile' }), ID)
    expect(setEnabled).toHaveBeenCalledWith(expect.objectContaining({ userDataPath: '/profile' }), ID, false)
    expect(applyManifest).toHaveBeenCalledWith(ID, 'now')
    expect(store.installFromStore).toHaveBeenCalledWith(ID)
    expect(store.updateFromStore).toHaveBeenCalledWith(ID)
    expect(store.checkForUpdates).toHaveBeenCalledOnce()
  })

  it('answers a read that needs no loaded extension at once', async () => {
    await extensionsSubsystem.afterReady!(runtime)
    expect(published.list()).toEqual([{ id: ID, name: 'x', enabled: true, path: '/slot/1' }])
    expect(published.commandKeys).toBeDefined()
    expect(published.prefs).toBeDefined()
  })

  it('makes the store hook of a test build wait the same way', async () => {
    await extensionsSubsystem.afterReady!(runtime)
    const answer = storeHook.installFromStore(ID)
    await flush()
    expect(store.installFromStore).not.toHaveBeenCalled()
    const tail = extensionsSubsystem.afterWindow!(runtime)
    await flush()
    releaseLoad()
    await tail
    await expect(answer).resolves.toEqual({ installed: true })
  })

  it('acts at once when asked after the tail has finished', async () => {
    await extensionsSubsystem.afterReady!(runtime)
    const tail = extensionsSubsystem.afterWindow!(runtime)
    await flush()
    releaseLoad()
    await tail
    order.length = 0
    await published.setEnabled(ID, true)
    expect(order).toEqual(['setEnabled'])
  })

  it('answers the waiting callers, and every later one, when the tail fails: the store refuses with the reason, the rest still acts', async () => {
    startWebStore.mockRejectedValueOnce(new Error('store preload missing'))
    await extensionsSubsystem.afterReady!(runtime)
    const waiting = published.installFromStore(ID)
    const change = published.setEnabled(ID, true)
    const tail = extensionsSubsystem.afterWindow!(runtime)
    await flush()
    releaseLoad()
    await expect(tail).rejects.toThrow('store preload missing')

    const refusal = { installed: false, reason: expect.stringContaining('could not be started') }
    await expect(waiting).resolves.toEqual(refusal)
    await expect(published.installFromStore(ID)).resolves.toEqual(refusal)
    await expect(published.updateFromStore(ID)).resolves.toEqual(refusal)
    await expect(published.checkForUpdates()).resolves.toBeUndefined()
    await expect(change).resolves.toBeUndefined()
    expect(setEnabled).toHaveBeenCalledOnce()
    expect(store.installFromStore).not.toHaveBeenCalled()
  })
})
