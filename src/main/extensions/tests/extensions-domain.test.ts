import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { extensionsDomain } from '../extensions-domain.js'
import type { ExtensionsDomainDeps } from '../extensions-domain.js'
import type { ShellServices } from '../../shell/shell-services.js'
import { createExtensionPrefsStore } from '../extension-prefs-runner.js'
import type { ExtensionFacts } from '../extensions-view.js'
import type { InstalledExtension } from '../registry.js'
import type { InstallOutcome } from '../install-runner.js'
import { fakeCommandKeys } from './command-keys-fixtures.js'

const UNPACKED: InstalledExtension = {
  id: 'abcdefghijklmnopabcdefghijklmnop',
  name: 'Fixture',
  version: '1.0.0',
  enabled: true,
  installedAt: 1000,
  updatedAt: 1000,
  source: { kind: 'unpacked', from: '/home/person/my-extension' },
  updater: { kind: 'none', reason: 'unpacked extensions have no update mechanism' },
  path: '/userData/extensions/u-aaaa/1.0.0',
  stripped: { permissions: [], optionalPermissions: [], declarativeNetRequest: undefined }
}

const FILE_ENTRY: InstalledExtension = { ...UNPACKED, id: 'file-entry', source: { kind: 'file', fileName: 'thing.zip' } }

const FACTS: ExtensionFacts = { resolvedName: 'Fixture', resolvedDescription: undefined, iconDataUrl: undefined, manifestFacts: undefined }

const caller = { page: 'extensions' as const, contents: {} as WebContents }

function buildDeps (overrides: Partial<ExtensionsDomainDeps> = {}): { deps: ExtensionsDomainDeps, entries: InstalledExtension[] } {
  const entries = [UNPACKED, FILE_ENTRY]
  const deps: ExtensionsDomainDeps = {
    extensions: {
      list: () => entries,
      setEnabled: vi.fn(async () => {}),
      uninstall: vi.fn(async () => {}),
      installFromFolder: vi.fn(async (): Promise<InstallOutcome> => ({ installed: true, entry: UNPACKED })),
      installFromFile: vi.fn(async (): Promise<InstallOutcome> => ({ installed: true, entry: UNPACKED })),
      installFromStore: vi.fn(async (): Promise<InstallOutcome> => ({ installed: true, entry: UNPACKED })),
      checkForUpdates: vi.fn(async () => {}),
      updateFromStore: vi.fn(async (): Promise<InstallOutcome> => ({ installed: true, entry: UNPACKED })),
      prefs: createExtensionPrefsStore(null),
      commandKeys: fakeCommandKeys(),
      applyManifest: vi.fn(async () => 'unchanged' as const)
    },
    prefs: createExtensionPrefsStore(null),
    host: () => undefined,
    shell: {} as ShellServices,
    isPrivate: false,
    readFacts: async () => FACTS,
    developerModeEnabled: () => false,
    pickFolder: vi.fn(async () => undefined),
    pickFile: vi.fn(async () => undefined),
    notify: vi.fn(),
    ...overrides
  }
  return { deps, entries }
}

describe('extensionsDomain', () => {
  it('is for the extensions page and no other', () => {
    expect(extensionsDomain(buildDeps().deps).pages).toEqual(['extensions'])
  })

  it('refuses a malformed or unknown command silently', async () => {
    const { deps } = buildDeps()
    const { handle } = extensionsDomain(deps)
    expect(await handle(null, caller)).toBeUndefined()
    expect(await handle({ type: 'nonsense' }, caller)).toBeUndefined()
    expect(await handle('a string', caller)).toBeUndefined()
  })

  it('lists every entry with its resolved facts', async () => {
    const { deps } = buildDeps()
    const { handle } = extensionsDomain(deps)
    const reply = await handle({ type: 'list' }, caller) as { rows: unknown[] }
    expect(reply.rows).toHaveLength(2)
  })

  it('says whether this is a private runtime', async () => {
    expect(await extensionsDomain(buildDeps().deps).handle({ type: 'context' }, caller)).toEqual({ isPrivate: false })
    expect(await extensionsDomain(buildDeps({ isPrivate: true }).deps).handle({ type: 'context' }, caller)).toEqual({ isPrivate: true })
  })

  it('carries the row and the empty parts a feature fills, in the details reply', async () => {
    const { deps } = buildDeps()
    const reply = await extensionsDomain(deps).handle({ type: 'details', id: UNPACKED.id }, caller) as { details: { row: { name: string, parts: object }, parts: object } }
    expect(reply.details.row.name).toBe('Fixture')
    expect(reply.details.row.parts).toEqual({})
    expect(reply.details.parts).toEqual({})
  })

  it('refuses details for an id no entry has', async () => {
    const { deps } = buildDeps()
    const { handle } = extensionsDomain(deps)
    expect(await handle({ type: 'details', id: 'nope' }, caller)).toBeUndefined()
  })

  it('gives the details of a known id', async () => {
    const { deps } = buildDeps()
    const { handle } = extensionsDomain(deps)
    const reply = await handle({ type: 'details', id: UNPACKED.id }, caller) as { details: { id: string } }
    expect(reply.details.id).toBe(UNPACKED.id)
  })

  it('setEnabled refuses an unknown id or a non-boolean value, and never calls through', async () => {
    const { deps } = buildDeps()
    const { handle } = extensionsDomain(deps)
    expect(await handle({ type: 'setEnabled', id: 'nope', enabled: true }, caller)).toBeUndefined()
    expect(await handle({ type: 'setEnabled', id: UNPACKED.id, enabled: 'yes' }, caller)).toBeUndefined()
    expect(deps.extensions.setEnabled).not.toHaveBeenCalled()
    expect(deps.notify).not.toHaveBeenCalled()
  })

  it('setEnabled applies a valid request and notifies', async () => {
    const { deps } = buildDeps()
    const { handle } = extensionsDomain(deps)
    expect(await handle({ type: 'setEnabled', id: UNPACKED.id, enabled: false }, caller)).toEqual({ ok: true })
    expect(deps.extensions.setEnabled).toHaveBeenCalledWith(UNPACKED.id, false)
    expect(deps.notify).toHaveBeenCalledTimes(1)
  })

  it('remove refuses an unknown id', async () => {
    const { deps } = buildDeps()
    const { handle } = extensionsDomain(deps)
    expect(await handle({ type: 'remove', id: 'nope' }, caller)).toBeUndefined()
    expect(deps.extensions.uninstall).not.toHaveBeenCalled()
  })

  it('remove uninstalls a known id and notifies', async () => {
    const { deps } = buildDeps()
    const { handle } = extensionsDomain(deps)
    expect(await handle({ type: 'remove', id: UNPACKED.id }, caller)).toEqual({ ok: true })
    expect(deps.extensions.uninstall).toHaveBeenCalledWith(UNPACKED.id)
    expect(deps.notify).toHaveBeenCalledTimes(1)
  })

  it('loadUnpacked is refused with Developer mode off, and never opens the picker', async () => {
    const { deps } = buildDeps({ developerModeEnabled: () => false })
    const { handle } = extensionsDomain(deps)
    expect(await handle({ type: 'loadUnpacked' }, caller)).toBeUndefined()
    expect(deps.pickFolder).not.toHaveBeenCalled()
  })

  it('loadUnpacked reports a cancelled picker without calling installFromFolder or notifying', async () => {
    const { deps } = buildDeps({ developerModeEnabled: () => true, pickFolder: vi.fn(async () => undefined) })
    const { handle } = extensionsDomain(deps)
    expect(await handle({ type: 'loadUnpacked' }, caller)).toEqual({ installed: false, reason: 'cancelled' })
    expect(deps.extensions.installFromFolder).not.toHaveBeenCalled()
    expect(deps.notify).not.toHaveBeenCalled()
  })

  it('loadUnpacked installs from the picked folder and notifies on success', async () => {
    const { deps } = buildDeps({ developerModeEnabled: () => true, pickFolder: vi.fn(async () => '/picked/folder') })
    const { handle } = extensionsDomain(deps)
    const reply = await handle({ type: 'loadUnpacked' }, caller)
    expect(reply).toEqual({ installed: true, entry: UNPACKED })
    expect(deps.extensions.installFromFolder).toHaveBeenCalledWith('/picked/folder', { contents: caller.contents })
    expect(deps.notify).toHaveBeenCalledTimes(1)
  })

  it('opens each picker over the extensions page that asked', async () => {
    const { deps } = buildDeps({ developerModeEnabled: () => true })
    const { handle } = extensionsDomain(deps)
    await handle({ type: 'loadUnpacked' }, caller)
    await handle({ type: 'installFromFile' }, caller)
    expect(deps.pickFolder).toHaveBeenCalledExactlyOnceWith(caller.contents)
    expect(deps.pickFile).toHaveBeenCalledExactlyOnceWith(caller.contents)
  })

  it('asks the install question in the extensions page\'s own tab, for a folder and for a file', async () => {
    const { deps } = buildDeps({ developerModeEnabled: () => true, pickFolder: vi.fn(async () => '/picked/folder'), pickFile: vi.fn(async () => '/picked/x.crx') })
    const { handle } = extensionsDomain(deps)
    await handle({ type: 'loadUnpacked' }, caller)
    await handle({ type: 'installFromFile' }, caller)
    expect(deps.extensions.installFromFolder).toHaveBeenCalledWith('/picked/folder', { contents: caller.contents })
    expect(deps.extensions.installFromFile).toHaveBeenCalledWith('/picked/x.crx', { contents: caller.contents })
  })

  it('loadUnpacked does not notify when the install itself is refused', async () => {
    const { deps } = buildDeps({
      developerModeEnabled: () => true,
      pickFolder: vi.fn(async () => '/picked/folder'),
      extensions: {
        list: () => [UNPACKED],
        setEnabled: vi.fn(async () => {}),
        uninstall: vi.fn(async () => {}),
        installFromFolder: vi.fn(async (): Promise<InstallOutcome> => ({ installed: false, reason: 'declined by the person' })),
        installFromFile: vi.fn(async (): Promise<InstallOutcome> => ({ installed: true, entry: UNPACKED })),
        installFromStore: vi.fn(async (): Promise<InstallOutcome> => ({ installed: true, entry: UNPACKED })),
        checkForUpdates: vi.fn(async () => {}),
        updateFromStore: vi.fn(async (): Promise<InstallOutcome> => ({ installed: true, entry: UNPACKED })),
        prefs: createExtensionPrefsStore(null),
        commandKeys: fakeCommandKeys(),
      applyManifest: vi.fn(async () => 'unchanged' as const)
      }
    })
    const { handle } = extensionsDomain(deps)
    expect(await handle({ type: 'loadUnpacked' }, caller)).toEqual({ installed: false, reason: 'declined by the person' })
    expect(deps.notify).not.toHaveBeenCalled()
  })

  it('reload is refused with Developer mode off', async () => {
    const { deps } = buildDeps({ developerModeEnabled: () => false })
    const { handle } = extensionsDomain(deps)
    expect(await handle({ type: 'reload', id: UNPACKED.id }, caller)).toBeUndefined()
  })

  it('reload is refused for a non-unpacked entry, even with Developer mode on', async () => {
    const { deps } = buildDeps({ developerModeEnabled: () => true })
    const { handle } = extensionsDomain(deps)
    expect(await handle({ type: 'reload', id: FILE_ENTRY.id }, caller)).toBeUndefined()
    expect(deps.extensions.installFromFolder).not.toHaveBeenCalled()
  })

  it('reload reinstalls an unpacked entry from its own recorded source folder', async () => {
    const { deps } = buildDeps({ developerModeEnabled: () => true })
    const { handle } = extensionsDomain(deps)
    await handle({ type: 'reload', id: UNPACKED.id }, caller)
    expect(deps.extensions.installFromFolder).toHaveBeenCalledWith('/home/person/my-extension', { contents: caller.contents })
    expect(deps.notify).toHaveBeenCalledTimes(1)
  })

  it('installFromFile needs no Developer mode, and reports a cancelled picker without notifying', async () => {
    const { deps } = buildDeps({ developerModeEnabled: () => false, pickFile: vi.fn(async () => undefined) })
    const { handle } = extensionsDomain(deps)
    expect(await handle({ type: 'installFromFile' }, caller)).toEqual({ installed: false, reason: 'cancelled' })
    expect(deps.extensions.installFromFile).not.toHaveBeenCalled()
  })

  it('installFromFile installs the picked file and notifies on success', async () => {
    const { deps } = buildDeps({ pickFile: vi.fn(async () => '/picked/file.zip') })
    const { handle } = extensionsDomain(deps)
    const reply = await handle({ type: 'installFromFile' }, caller)
    expect(reply).toEqual({ installed: true, entry: UNPACKED })
    expect(deps.extensions.installFromFile).toHaveBeenCalledWith('/picked/file.zip', { contents: caller.contents })
    expect(deps.notify).toHaveBeenCalledTimes(1)
  })

  it('checkForUpdates checks every store entry and notifies', async () => {
    const { deps } = buildDeps()
    const { handle } = extensionsDomain(deps)
    expect(await handle({ type: 'checkForUpdates' }, caller)).toEqual({ ok: true })
    expect(deps.extensions.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(deps.notify).toHaveBeenCalledTimes(1)
  })

  it('updateNow refuses an unknown id', async () => {
    const { deps } = buildDeps()
    const { handle } = extensionsDomain(deps)
    expect(await handle({ type: 'updateNow', id: 'nope' }, caller)).toBeUndefined()
    expect(deps.extensions.updateFromStore).not.toHaveBeenCalled()
  })

  it('updateNow installs the pending update for a known id and notifies on success', async () => {
    const { deps } = buildDeps()
    const { handle } = extensionsDomain(deps)
    const reply = await handle({ type: 'updateNow', id: UNPACKED.id }, caller)
    expect(reply).toEqual({ installed: true, entry: UNPACKED })
    expect(deps.extensions.updateFromStore).toHaveBeenCalledWith(UNPACKED.id)
    expect(deps.notify).toHaveBeenCalledTimes(1)
  })
})
