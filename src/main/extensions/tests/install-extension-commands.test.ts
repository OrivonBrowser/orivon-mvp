import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseBinding } from '../../shortcuts/accelerator.js'
import type { Chord } from '../../shortcuts/accelerator.js'
import { createExtensionPrefsStore } from '../extension-prefs-runner.js'

// The session's extensions, as far as this reads them: a list it can be asked
// for and the two events it listens to.
const sessionExtensions = Object.assign(new EventEmitter(), { getAllExtensions: vi.fn((): unknown[] => []) })
const defaultSession = { extensions: sessionExtensions }
Object.assign(sessionExtensions, { owner: defaultSession })
vi.mock('electron', () => ({ session: { defaultSession } }))
const sendCommand = vi.hoisted(() => vi.fn((_id: string, _name: string, _tab: unknown) => {}))
const isVisibleExtensionTab = vi.hoisted(() => vi.fn((_tab: unknown) => true))
vi.mock('../extension-host.js', () => ({ extensionHost: () => ({ sendCommand, activateAction: () => {}, listActions: () => [] }), isVisibleExtensionTab }))
const openSidePanelFor = vi.hoisted(() => vi.fn((_id: string, _tab: unknown, _window: unknown) => true))
vi.mock('../side-panel-runner.js', () => ({ openSidePanelFor }))
const registry = vi.hoisted(() => ({ entries: [] as Array<{ id: string, installedAt: number }> }))
vi.mock('../registry-runner.js', () => ({ readRegistry: () => registry.entries }))

const { installExtensionCommands } = await import('../install-extension-commands.js')

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orivon-ext-commands-'))
  sessionExtensions.removeAllListeners()
  sessionExtensions.getAllExtensions.mockReset().mockReturnValue([])
  sendCommand.mockClear()
  isVisibleExtensionTab.mockReset().mockReturnValue(true)
  registry.entries = []
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function loaded (id: string, commands: Record<string, unknown>, folderCommands: Record<string, unknown> = commands): unknown {
  const folder = join(dir, id)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'manifest.json'), JSON.stringify({ name: id, commands: folderCommands }))
  return { id, name: id, path: folder, manifest: { name: id, commands } }
}

const KEYS = () => installExtensionCommands({ prefs: createExtensionPrefsStore(null), userDataPath: dir })
const environment = { shortcuts: { commandFor: () => null, onChange: () => () => {} }, windows: { findOwner: () => undefined, focused: () => undefined } }

describe('installExtensionCommands', () => {
  it('lists the commands of what the session has loaded, the earliest install first', () => {
    registry.entries = [{ id: 'late', installedAt: 20 }, { id: 'early', installedAt: 10 }]
    sessionExtensions.getAllExtensions.mockReturnValue([
      loaded('late', { b: { description: 'B', suggested_key: 'Alt+B' } }),
      loaded('early', { a: { description: 'A', suggested_key: 'Alt+B' } }),
      loaded('unwritten', { c: { description: 'C' } })
    ])
    const keys = KEYS()
    keys.ready(environment)
    expect(keys.groups().map((group) => group.id)).toEqual(['early', 'late', 'unwritten'])
    // The first installed holds the key both ask for.
    expect(keys.getAll('early')[0]?.shortcut).toBe('Alt+B')
    expect(keys.getAll('late')[0]?.shortcut).toBe('')
  })

  it('lists the commands in the order the manifest file gives them, not the sorted order it was loaded in', () => {
    sessionExtensions.getAllExtensions.mockReturnValue([
      loaded('one', { alpha: { description: 'A' }, zulu: { description: 'Z' } }, { zulu: { description: 'Z' }, alpha: { description: 'A' } })
    ])
    const keys = KEYS()
    keys.ready(environment)
    expect(keys.groups()[0]?.commands.map((command) => command.name)).toEqual(['zulu', 'alpha'])
  })

  it('follows an extension that loads or unloads', () => {
    const keys = KEYS()
    keys.ready(environment)
    expect(keys.groups()).toEqual([])
    sessionExtensions.getAllExtensions.mockReturnValue([loaded('one', { a: { description: 'A' } })])
    sessionExtensions.emit('extension-loaded')
    expect(keys.groups().map((group) => group.id)).toEqual(['one'])
    sessionExtensions.getAllExtensions.mockReturnValue([])
    sessionExtensions.emit('extension-unloaded')
    expect(keys.groups()).toEqual([])
  })

  it('reads the manifest files once per load, not on each rebuild of the table', () => {
    const entry = loaded('one', { alpha: { description: 'A' }, zulu: { description: 'Z' } }, { zulu: { description: 'Z' }, alpha: { description: 'A' } }) as { path: string }
    sessionExtensions.getAllExtensions.mockReturnValue([entry])
    const prefs = createExtensionPrefsStore(null)
    const keys = installExtensionCommands({ prefs, userDataPath: dir })
    keys.ready(environment)
    const names = (): string[] => keys.groups()[0]?.commands.map((command) => command.name) ?? []
    expect(names()).toEqual(['zulu', 'alpha'])
    // The file changes under it: a rebuild caused by a prefs change must not notice.
    writeFileSync(join(entry.path, 'manifest.json'), JSON.stringify({ name: 'one', commands: { alpha: { description: 'A' }, zulu: { description: 'Z' } } }))
    prefs.update('one', { shortcuts: { alpha: 'Mod+Shift+U' } })
    expect(names()).toEqual(['zulu', 'alpha'])
    sessionExtensions.emit('extension-loaded')
    expect(names()).toEqual(['alpha', 'zulu'])
  })

  it('opens the extension\'s side panel from its key, and passes the key on when there is no panel', () => {
    const tab = { isDestroyed: () => false, session: (sessionExtensions as unknown as { owner: unknown }).owner, getURL: () => 'https://a.example/' }
    const window = { window: { isDestroyed: () => false }, tabs: { activeWebContents: () => tab } }
    sessionExtensions.getAllExtensions.mockReturnValue([loaded('one', { _execute_side_panel: { suggested_key: { default: 'Alt+Shift+P' }, description: 'Panel' } })])
    const keys = KEYS()
    keys.ready({ ...environment, windows: { findOwner: () => undefined, focused: () => window as never } })
    expect(keys.groups()[0]?.commands[0]?.unavailable).toBeNull()
    const press = parseBinding('Alt+Shift+P', 'linux') as Chord
    expect(keys.run(press, tab as never)).toBe(true)
    expect(openSidePanelFor).toHaveBeenCalledWith('one', tab, window)
    openSidePanelFor.mockReturnValueOnce(false)
    expect(keys.run(press, tab as never)).toBe(false)
  })

  describe('the tab a command key is told about', () => {
    const tabIn = (session: unknown, url: string): unknown => Object.assign(new EventEmitter(), { id: 7, isDestroyed: () => false, session, getURL: () => url })
    // The origin of every tab here holds Orivon grants, so a grant check in the runner would hide each of them.
    const holdsGrants = { hasGrantsSync: () => true }
    const press = parseBinding('Alt+Shift+K', 'linux') as Chord
    const run = (tab: unknown): boolean => {
      sessionExtensions.getAllExtensions.mockReturnValue([loaded('one', { mark: { suggested_key: { default: 'Alt+Shift+K' }, description: 'Mark' } })])
      const keys = KEYS()
      const window = { window: { isDestroyed: () => false }, tabs: { activeWebContents: () => tab } }
      keys.ready({ ...environment, windows: { findOwner: () => undefined, focused: () => window as never } })
      return keys.run(press, tab as never)
    }

    it('is the tab in front when an extension can see it, whatever permissions its site holds', () => {
      const tab = Object.assign(tabIn(defaultSession, 'https://granted.example/') as object, { broker: holdsGrants })
      expect(run(tab)).toBe(true)
      expect(isVisibleExtensionTab).toHaveBeenCalledWith(tab)
      expect(sendCommand).toHaveBeenCalledWith('one', 'mark', tab)
    })

    it('is none when no extension can see it, and the key still goes to the extension', () => {
      isVisibleExtensionTab.mockReturnValue(false)
      expect(run(tabIn({ extensions: new EventEmitter() }, 'https://page.example/'))).toBe(true)
      expect(sendCommand).toHaveBeenCalledWith('one', 'mark', undefined)
    })
  })

  it('lists the extensions a private runtime has loaded', () => {
    sessionExtensions.getAllExtensions.mockReturnValue([loaded('one', { a: { description: 'A' } })])
    const keys = KEYS()
    keys.ready(environment)
    expect(keys.groups().map((group) => group.id)).toEqual(['one'])
  })

  it('has nothing in a private runtime that loaded no extension', () => {
    sessionExtensions.getAllExtensions.mockReturnValue([])
    const keys = KEYS()
    keys.ready(environment)
    expect(keys.groups()).toEqual([])
  })
})
