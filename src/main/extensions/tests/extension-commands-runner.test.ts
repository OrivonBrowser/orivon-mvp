import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { parseBinding } from '../../shortcuts/accelerator.js'
import type { Chord } from '../../shortcuts/accelerator.js'
import type { ShellWindow } from '../../shell/window-registry.js'
import { createExtensionPrefsStore } from '../extension-prefs-runner.js'
import { createExtensionCommandKeys } from '../extension-commands-runner.js'
import type { CommandKeysDeps, KeysEnvironment, RecordedOutcome } from '../extension-commands-runner.js'

const A = 'a'.repeat(32)
const B = 'b'.repeat(32)
const chord = (text: string): Chord => parseBinding(text, 'linux') as Chord

const MANIFEST_A = { commands: { _execute_action: { suggested_key: 'Ctrl+Shift+Y' }, mark: { suggested_key: 'Alt+Shift+K', description: 'Mark' }, clash: { suggested_key: 'Ctrl+T' } } }
const MANIFEST_B = { commands: { other: { suggested_key: 'Alt+Shift+K' } } }

function setup (options: { extensions?: CommandKeysDeps['extensions'], withSidePanel?: boolean, appTab?: boolean, activeTab?: WebContents | undefined } = {}) {
  const prefs = createExtensionPrefsStore(null)
  const sendCommand = vi.fn()
  const activateAction = vi.fn()
  const recordInvocation = vi.fn()
  const recorded = vi.fn<(page: unknown, outcome: RecordedOutcome) => void>()
  const openSidePanel = vi.fn(() => true)
  const keyChanged = vi.fn()
  const tab = { isDestroyed: () => false } as unknown as WebContents
  const window = {
    window: { isDestroyed: () => false },
    tabs: { activeWebContents: () => ('activeTab' in options ? options.activeTab : tab) }
  } as unknown as ShellWindow
  const loaded = new Set<() => void>()
  const orivonChanged = new Set<() => void>()
  const orivon = { commandFor: (c: Chord) => (c.key === 't' && c.ctrl ? 'tab.new' : null) as never, onChange: (l: () => void) => { orivonChanged.add(l); return () => { orivonChanged.delete(l) } } }
  const keys = createExtensionCommandKeys({
    platform: 'linux',
    prefs,
    extensions: options.extensions ?? (() => [{ id: A, name: 'Alpha', manifest: MANIFEST_A }, { id: B, name: 'Beta', manifest: MANIFEST_B }]),
    onExtensionsChanged: (l) => { loaded.add(l); return () => { loaded.delete(l) } },
    host: () => ({ sendCommand, activateAction, listActions: () => [{ id: A }] }),
    recordInvocation,
    isHiddenTab: () => options.appTab === true,
    anchorFor: async () => ({ x: 1, y: 2, width: 3, height: 4 }),
    recorded,
    keyChanged,
    ...(options.withSidePanel === true ? { openSidePanel } : {}),
    log: () => {}
  })
  const env: KeysEnvironment = { shortcuts: orivon, windows: { findOwner: () => window, focused: () => window } }
  return { keys, prefs, env, sendCommand, activateAction, recordInvocation, recorded, keyChanged, openSidePanel, tab, loaded, orivonChanged, window }
}

const flush = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 0)) }

describe('command keys before the shortcuts are ready', () => {
  it('bind nothing and run nothing', () => {
    const { keys } = setup()
    expect(keys.handles(chord('Alt+Shift+K'))).toBe(false)
    expect(keys.groups()).toEqual([])
    expect(keys.run(chord('Alt+Shift+K'), {} as WebContents)).toBe(false)
  })

  it('release whenReady once ready', async () => {
    const { keys, env } = setup()
    let done = false
    void keys.whenReady().then(() => { done = true })
    await flush()
    expect(done).toBe(false)
    keys.ready(env)
    await flush()
    expect(done).toBe(true)
  })
})

describe('running a command key', () => {
  it('fires onCommand with the active tab and counts it as an invocation', () => {
    const { keys, env, sendCommand, recordInvocation, tab } = setup()
    keys.ready(env)
    expect(keys.run(chord('Alt+Shift+K'), tab)).toBe(true)
    expect(recordInvocation).toHaveBeenCalledWith(A, tab)
    expect(sendCommand).toHaveBeenCalledWith(A, 'mark', tab)
  })

  it('gives a key to the first installed extension that wants it', () => {
    const { keys, env, sendCommand, tab } = setup()
    keys.ready(env)
    keys.run(chord('Alt+Shift+K'), tab)
    expect(sendCommand).toHaveBeenCalledTimes(1)
    expect(sendCommand.mock.calls[0]?.[0]).toBe(A)
  })

  it('never takes a key Orivon holds', () => {
    const { keys, env } = setup()
    keys.ready(env)
    expect(keys.handles(chord('Mod+T'))).toBe(false)
  })

  it('activates the action for _execute_action, under the anchor', async () => {
    const { keys, env, activateAction, sendCommand, tab } = setup()
    keys.ready(env)
    expect(keys.run(chord('Mod+Shift+Y'), tab)).toBe(true)
    await flush()
    expect(activateAction).toHaveBeenCalledWith(A, tab, { x: 1, y: 2, width: 3, height: 4 })
    expect(sendCommand).not.toHaveBeenCalled()
  })

  it('tells an extension nothing of a hidden tab (an app\'s or an internal page), and leaves the action key to the page', () => {
    const { keys, env, sendCommand, recordInvocation, tab } = setup({ appTab: true })
    keys.ready(env)
    expect(keys.run(chord('Alt+Shift+K'), tab)).toBe(true)
    expect(sendCommand).toHaveBeenCalledWith(A, 'mark', undefined)
    expect(recordInvocation).not.toHaveBeenCalled()
    expect(keys.run(chord('Mod+Shift+Y'), tab)).toBe(false)
  })

  it('still fires onCommand when no tab is active', () => {
    const { keys, env, sendCommand, tab } = setup({ activeTab: undefined })
    keys.ready(env)
    expect(keys.run(chord('Alt+Shift+K'), tab)).toBe(true)
    expect(sendCommand).toHaveBeenCalledWith(A, 'mark', undefined)
  })

  it('leaves the side-panel key to the page while nothing can open one', () => {
    const manifest = { commands: { _execute_side_panel: { suggested_key: 'Alt+P' } } }
    const off = setup({ extensions: () => [{ id: A, name: 'Alpha', manifest }] })
    off.keys.ready(off.env)
    expect(off.keys.run(chord('Alt+P'), off.tab)).toBe(false)
    expect(off.keys.groups()[0]?.commands[0]?.unavailable).toMatch(/not available/i)
    const on = setup({ extensions: () => [{ id: A, name: 'Alpha', manifest }], withSidePanel: true })
    on.keys.ready(on.env)
    expect(on.keys.run(chord('Alt+P'), on.tab)).toBe(true)
    expect(on.openSidePanel).toHaveBeenCalledWith(A, on.tab, on.window)
    expect(on.keys.groups()[0]?.commands[0]?.unavailable).toBeNull()
  })

  it('stops answering for an extension once it unloads', () => {
    let list = [{ id: A, name: 'Alpha', manifest: MANIFEST_A }]
    const { keys, env, loaded } = setup({ extensions: () => list })
    keys.ready(env)
    expect(keys.handles(chord('Alt+Shift+K'))).toBe(true)
    list = []
    for (const listener of loaded) listener()
    expect(keys.handles(chord('Alt+Shift+K'))).toBe(false)
  })

  it('follows a change of an Orivon shortcut', () => {
    const { keys, env, orivonChanged } = setup()
    keys.ready(env)
    const changed = vi.fn()
    keys.onChange(changed)
    for (const listener of orivonChanged) listener()
    expect(changed).toHaveBeenCalledTimes(1)
  })
})

describe('commands.getAll', () => {
  it('reports the live shortcut in the manifest\'s own words', () => {
    const { keys, env } = setup()
    keys.ready(env)
    expect(keys.getAll(A)).toEqual([
      { name: '_execute_action', description: '', shortcut: 'Ctrl+Shift+Y' },
      { name: 'mark', description: 'Mark', shortcut: 'Alt+Shift+K' },
      { name: 'clash', description: '', shortcut: '' }
    ])
    expect(keys.getAll(B)).toEqual([{ name: 'other', description: '', shortcut: '' }])
    expect(keys.getAll('c'.repeat(32))).toEqual([])
  })
})

describe('the page\'s view', () => {
  it('groups commands by extension with key caps and a blocked suggestion', () => {
    const { keys, env } = setup()
    keys.ready(env)
    const groups = keys.groups()
    expect(groups.map((group) => group.id)).toEqual([A, B])
    expect(groups[0]?.commands.map((command) => command.keys)).toEqual([['Ctrl', 'Shift', 'Y'], ['Alt', 'Shift', 'K'], null])
    expect(groups[0]?.commands[2]?.suggestedKeys).toEqual(['Ctrl', 'T'])
    expect(groups[1]?.commands[0]).toMatchObject({ keys: null, suggestedKeys: ['Alt', 'Shift', 'K'] })
  })
})

describe('recording a key', () => {
  it('stores the chosen key and tells the page', () => {
    const { keys, env, prefs, recorded } = setup()
    keys.ready(env)
    const page = {}
    expect(keys.beginRecording(page, A, 'mark')).toBe(true)
    expect(keys.isRecording(page)).toBe(true)
    expect(keys.isRecording({})).toBe(false)
    keys.record(page, chord('Mod+Shift+U'))
    expect(keys.isRecording(page)).toBe(false)
    expect(prefs.get(A).shortcuts).toEqual({ mark: 'Mod+Shift+U' })
    expect(recorded).toHaveBeenCalledWith(page, { extensionId: A, name: 'mark', keys: ['Ctrl', 'Shift', 'U'], result: { status: 'ok', binding: 'Mod+Shift+U' } })
    expect(keys.getAll(A)[1]?.shortcut).toBe('Ctrl+Shift+U')
    expect(keys.handles(chord('Mod+Shift+U'))).toBe(true)
    // The key the command let go of is free for the suggestion another extension had been refused.
    expect(keys.getAll(B)[0]?.shortcut).toBe('Alt+Shift+K')
  })

  it('refuses to record a command the table does not have', () => {
    const { keys, env } = setup()
    keys.ready(env)
    expect(keys.beginRecording({}, A, 'nothing')).toBe(false)
    expect(keys.beginRecording({}, 'c'.repeat(32), 'mark')).toBe(false)
  })

  it('ignores a key from a page that did not ask', () => {
    const { keys, env, prefs, recorded } = setup()
    keys.ready(env)
    keys.beginRecording({}, A, 'mark')
    keys.record({}, chord('Mod+Shift+U'))
    expect(recorded).not.toHaveBeenCalled()
    expect(prefs.get(A).shortcuts).toEqual({})
  })

  it('cancels on Escape alone', () => {
    const { keys, env, prefs, recorded } = setup()
    keys.ready(env)
    const page = {}
    keys.beginRecording(page, A, 'mark')
    keys.record(page, { ctrl: false, alt: false, shift: false, meta: false, key: 'Escape' })
    expect(recorded).toHaveBeenCalledWith(page, { extensionId: A, name: 'mark', keys: null, result: { status: 'cancelled' } })
    expect(prefs.get(A).shortcuts).toEqual({})
  })

  it('can be cancelled from outside', () => {
    const { keys, env } = setup()
    keys.ready(env)
    const page = {}
    keys.beginRecording(page, A, 'mark')
    keys.cancelRecording()
    expect(keys.isRecording(page)).toBe(false)
  })

  it('reports an Orivon key and stores nothing', () => {
    const { keys, env, prefs, recorded } = setup()
    keys.ready(env)
    const page = {}
    keys.beginRecording(page, A, 'clash')
    keys.record(page, chord('Mod+T'))
    expect(recorded.mock.calls[0]?.[1]).toMatchObject({ result: { status: 'orivon', label: 'New tab' }, keys: ['Ctrl', 'T'] })
    expect(prefs.get(A).shortcuts).toEqual({})
  })

  it('reports the extension that holds the key and stores nothing', () => {
    const { keys, env, prefs, recorded } = setup()
    keys.ready(env)
    const page = {}
    keys.beginRecording(page, B, 'other')
    keys.record(page, chord('Alt+Shift+K'))
    expect(recorded.mock.calls[0]?.[1]).toMatchObject({ result: { status: 'extension', holder: { extensionId: A, name: 'mark' } } })
    expect(prefs.get(B).shortcuts).toEqual({})
  })

  it('refuses a bare key', () => {
    const { keys, env, recorded } = setup()
    keys.ready(env)
    const page = {}
    keys.beginRecording(page, A, 'mark')
    keys.record(page, chord('K'))
    expect(recorded.mock.calls[0]?.[1]).toMatchObject({ result: { status: 'invalid', problem: 'needs-modifier' } })
  })
})

describe('a recording and a move of a command that is not there', () => {
  it('a second page recording tells the first its recording ended', () => {
    const { keys, env, recorded } = setup()
    keys.ready(env)
    const first = {}
    const second = {}
    keys.beginRecording(first, A, 'mark')
    keys.beginRecording(second, B, 'other')
    expect(recorded).toHaveBeenCalledWith(first, { extensionId: A, name: 'mark', keys: null, result: { status: 'cancelled' } })
    expect(keys.isRecording(first)).toBe(false)
    expect(keys.isRecording(second)).toBe(true)
  })

  it('records nothing for a command whose extension was unloaded during the recording', () => {
    let present = true
    const { keys, env, prefs, recorded, loaded } = setup({ extensions: () => present ? [{ id: A, name: 'Alpha', manifest: MANIFEST_A }] : [] })
    keys.ready(env)
    const page = {}
    keys.beginRecording(page, A, 'mark')
    present = false
    for (const listener of loaded) listener()
    keys.record(page, chord('Mod+Shift+U'))
    expect(prefs.get(A).shortcuts).toEqual({})
    expect(recorded).toHaveBeenCalledWith(page, { extensionId: A, name: 'mark', keys: null, result: { status: 'cancelled' } })
  })

  it('refuses a move of a command the table does not have, and strips no other extension\'s key', () => {
    const { keys, env, prefs, keyChanged } = setup()
    keys.ready(env)
    expect(keys.move('c'.repeat(32), 'ghost', chord('Alt+Shift+K'))).toEqual({ status: 'invalid', problem: 'unsupported' })
    expect(keys.move(A, 'nothing', chord('Alt+Shift+K'))).toEqual({ status: 'invalid', problem: 'unsupported' })
    expect(prefs.get(A).shortcuts).toEqual({})
    expect(prefs.get('c'.repeat(32)).shortcuts).toEqual({})
    expect(keyChanged).not.toHaveBeenCalled()
  })
})

describe('chrome.commands.onChanged', () => {
  it('tells an extension its command moved to another key', () => {
    const { keys, env, keyChanged } = setup()
    keys.ready(env)
    const page = {}
    keys.beginRecording(page, A, 'mark')
    keys.record(page, chord('Mod+Shift+U'))
    expect(keyChanged).toHaveBeenCalledWith(A, { name: 'mark', oldShortcut: 'Alt+Shift+K', newShortcut: 'Ctrl+Shift+U' })
    // The suggestion the other extension had been refused is free now, and it is told.
    expect(keyChanged).toHaveBeenCalledWith(B, { name: 'other', oldShortcut: '', newShortcut: 'Alt+Shift+K' })
    expect(keyChanged).toHaveBeenCalledTimes(2)
  })

  it('tells both extensions when a key moves between them', () => {
    const { keys, env, keyChanged } = setup()
    keys.ready(env)
    keys.move(B, 'other', chord('Alt+Shift+K'))
    expect(keyChanged).toHaveBeenCalledWith(A, { name: 'mark', oldShortcut: 'Alt+Shift+K', newShortcut: '' })
    expect(keyChanged).toHaveBeenCalledWith(B, { name: 'other', oldShortcut: '', newShortcut: 'Alt+Shift+K' })
  })

  it('tells nothing for a key that stayed or a refused one', () => {
    const { keys, env, keyChanged } = setup()
    keys.ready(env)
    const page = {}
    keys.beginRecording(page, A, 'mark')
    keys.record(page, chord('Alt+Shift+K'))
    keys.beginRecording(page, A, 'mark')
    keys.record(page, chord('Mod+T'))
    expect(keyChanged).not.toHaveBeenCalled()
  })

  it('tells an extension a key was cleared', () => {
    const { keys, env, keyChanged } = setup()
    keys.ready(env)
    keys.clear(A, 'mark')
    expect(keyChanged).toHaveBeenCalledWith(A, { name: 'mark', oldShortcut: 'Alt+Shift+K', newShortcut: '' })
  })
})

describe('clearing and moving', () => {
  it('clears a command so its suggestion does not come back', () => {
    const { keys, env, prefs } = setup()
    keys.ready(env)
    expect(keys.clear(A, 'mark')).toBe(true)
    expect(prefs.get(A).shortcuts).toEqual({ mark: '' })
    expect(keys.handles(chord('Alt+Shift+K'))).toBe(true)
    expect(keys.getAll(A)[1]?.shortcut).toBe('')
    expect(keys.clear(A, 'nothing')).toBe(false)
  })

  it('moves a key from the command that holds it', () => {
    const { keys, env, prefs, sendCommand, tab } = setup()
    keys.ready(env)
    const outcome = keys.move(B, 'other', chord('Alt+Shift+K'))
    expect(outcome.status).toBe('extension')
    expect(prefs.get(A).shortcuts).toEqual({ mark: '' })
    expect(prefs.get(B).shortcuts).toEqual({ other: 'Alt+Shift+K' })
    keys.run(chord('Alt+Shift+K'), tab)
    expect(sendCommand).toHaveBeenCalledWith(B, 'other', tab)
  })

  it('moves nothing onto an Orivon key', () => {
    const { keys, env, prefs } = setup()
    keys.ready(env)
    expect(keys.move(B, 'other', chord('Mod+T')).status).toBe('orivon')
    expect(prefs.get(B).shortcuts).toEqual({})
  })
})
