import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { createExtensionPrefsStore } from '../extension-prefs-runner.js'
import { shortcutsCancel, shortcutsClear, shortcutsList, shortcutsMove, shortcutsPart, shortcutsRecord } from '../shortcuts-page.js'
import type { ExtensionsDomainDeps } from '../extensions-domain.js'
import type { ExtensionCommandKeys } from '../extension-commands-runner.js'
import type { InstalledExtension } from '../registry.js'
import { fakeCommandKeys } from './command-keys-fixtures.js'

const caller = { page: 'extensions' as const, contents: {} as WebContents }
const entry = (id: string, name: string): InstalledExtension => ({
  id, name, version: '1.0.0', enabled: true, installedAt: 1, updatedAt: 1, source: { kind: 'file', fileName: 'x.zip' },
  updater: { kind: 'none', reason: 'x' }, path: `/no/such/folder/${id}`, stripped: { permissions: [], optionalPermissions: [], declarativeNetRequest: undefined }
})
const row = (name: string) => ({ name, description: '', kind: 'named' as const, keys: null, suggestedKeys: null, unavailable: null })

function deps (keys: ExtensionCommandKeys, installed: InstalledExtension[]): ExtensionsDomainDeps {
  return {
    extensions: { list: () => installed, commandKeys: keys, prefs: createExtensionPrefsStore(null) } as never,
    prefs: createExtensionPrefsStore(null),
    host: () => undefined,
    shell: {} as never,
    isPrivate: false,
    readFacts: async (item) => ({ resolvedName: `Name of ${item.name}`, resolvedDescription: undefined, iconDataUrl: 'data:image/png;base64,AA==', manifestFacts: undefined }),
    developerModeEnabled: () => false,
    pickFolder: async () => undefined,
    pickFile: async () => undefined,
    notify: () => {}
  }
}

describe('shortcuts.list', () => {
  it('lists the extensions with commands by their resolved name, sorted', async () => {
    const keys = fakeCommandKeys({ groups: () => [{ id: 'b', name: 'b', commands: [row('x')] }, { id: 'a', name: 'a', commands: [row('y')] }] })
    const reply = await shortcutsList({}, deps(keys, [entry('a', 'Zed'), entry('b', 'Able'), entry('c', 'No commands')])) as { platform: string, installed: number, extensions: Array<{ id: string, name: string, iconDataUrl: string }> }
    expect(reply.platform).toBe('linux')
    expect(reply.installed).toBe(3)
    expect(reply.extensions.map((extension) => extension.name)).toEqual(['Name of Able', 'Name of Zed'])
    expect(reply.extensions[0]?.iconDataUrl).toMatch(/^data:image\/png/)
  })

  it('answers an empty list when no extension declares a command', async () => {
    const reply = await shortcutsList({}, deps(fakeCommandKeys(), [entry('a', 'Zed')])) as { installed: number, extensions: unknown[] }
    expect(reply).toMatchObject({ installed: 1, extensions: [] })
  })
})

describe('recording requests', () => {
  it('start recording for the page that asked, naming the extension and command', () => {
    const beginRecording = vi.fn(() => true)
    const d = deps(fakeCommandKeys({ beginRecording }), [])
    expect(shortcutsRecord({ id: 'a', name: 'go' }, d, caller)).toBe(true)
    expect(beginRecording).toHaveBeenCalledWith(caller.contents, 'a', 'go')
  })

  it('take anything but text as nothing', () => {
    const beginRecording = vi.fn(() => false)
    shortcutsRecord({ id: { x: 1 }, name: 5 }, deps(fakeCommandKeys({ beginRecording }), []), caller)
    expect(beginRecording).toHaveBeenCalledWith(caller.contents, '', '')
  })

  it('cancel only a recording that is this page\'s own', () => {
    const cancelRecording = vi.fn()
    shortcutsCancel({}, deps(fakeCommandKeys({ isRecording: () => false, cancelRecording }), []), caller)
    expect(cancelRecording).not.toHaveBeenCalled()
    shortcutsCancel({}, deps(fakeCommandKeys({ isRecording: (owner) => owner === caller.contents, cancelRecording }), []), caller)
    expect(cancelRecording).toHaveBeenCalledTimes(1)
  })
})

describe('shortcuts.clear and shortcuts.move', () => {
  it('clear one command', () => {
    const clear = vi.fn(() => true)
    expect(shortcutsClear({ id: 'a', name: 'go' }, deps(fakeCommandKeys({ clear }), []))).toBe(true)
    expect(clear).toHaveBeenCalledWith('a', 'go')
  })

  it('move reads the binding in Orivon\'s grammar and refuses text that is not one', () => {
    const move = vi.fn(() => ({ status: 'ok' as const, binding: 'Mod+Shift+U' }))
    const d = deps(fakeCommandKeys({ move }), [])
    expect(shortcutsMove({ id: 'a', name: 'go', binding: 'Mod+Shift+U' }, d)).toEqual({ status: 'ok', binding: 'Mod+Shift+U' })
    expect(move).toHaveBeenCalledWith('a', 'go', expect.objectContaining({ ctrl: true, shift: true, key: 'u' }))
    expect(shortcutsMove({ id: 'a', name: 'go', binding: 'nonsense' }, d)).toEqual({ status: 'invalid', problem: 'unsupported' })
    expect(move).toHaveBeenCalledTimes(1)
  })
})

describe('the details part', () => {
  it('counts an extension\'s commands, and says nothing for one with none', () => {
    const keys = fakeCommandKeys({ groups: () => [{ id: 'a', name: 'a', commands: [row('x'), row('y')] }] })
    const d = deps(keys, [])
    const facts = {} as never
    expect(shortcutsPart(entry('a', 'A'), facts, d)).toEqual({ shortcuts: { commands: 2 } })
    expect(shortcutsPart(entry('b', 'B'), facts, d)).toEqual({})
  })
})
