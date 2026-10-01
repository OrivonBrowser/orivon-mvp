import { describe, expect, it } from 'vitest'
import { parseBinding } from '../../shortcuts/accelerator.js'
import type { Chord } from '../../shortcuts/accelerator.js'
import { assign, parseCommands, resolveBindings, toBinding, toChromeText } from '../extension-commands.js'
import type { CommandEntry, ExtensionCommandSet } from '../extension-commands.js'

const chord = (text: string, platform: NodeJS.Platform = 'linux'): Chord => parseBinding(text, platform) as Chord

describe('toBinding', () => {
  it('reads the manifest grammar into Orivon bindings', () => {
    expect(toBinding('Ctrl+Shift+Y', 'linux')).toBe('Mod+Shift+Y')
    expect(toBinding('Alt+Shift+K', 'win32')).toBe('Alt+Shift+K')
    expect(toBinding('Ctrl+Alt+5', 'linux')).toBe('Mod+Alt+5')
    expect(toBinding('Alt+F7', 'linux')).toBe('Alt+F7')
  })

  it('accepts every key name the manifest allows', () => {
    for (const key of ['Comma', 'Period', 'Home', 'End', 'PageUp', 'PageDown', 'Space', 'Insert', 'Delete', 'Up', 'Down', 'Left', 'Right']) {
      expect(toBinding(`Ctrl+${key}`, 'linux'), key).not.toBeNull()
    }
    expect(toBinding('Ctrl+Comma', 'linux')).toBe('Mod+,')
    expect(toBinding('Ctrl+Period', 'linux')).toBe('Mod+.')
    for (let n = 1; n <= 12; n += 1) expect(toBinding(`Alt+F${String(n)}`, 'linux')).toBe(`Alt+F${String(n)}`)
  })

  it('treats Ctrl as the command key on macOS and MacCtrl as control', () => {
    expect(toBinding('Ctrl+Shift+Y', 'darwin')).toBe('Mod+Shift+Y')
    expect(toBinding('Command+Shift+Y', 'darwin')).toBe('Mod+Shift+Y')
    expect(toBinding('MacCtrl+Shift+Y', 'darwin')).toBe('Ctrl+Shift+Y')
    const mac = chord(toBinding('Ctrl+Y', 'darwin') as string, 'darwin')
    expect(mac).toMatchObject({ meta: true, ctrl: false })
    expect(chord(toBinding('MacCtrl+Y', 'darwin') as string, 'darwin')).toMatchObject({ meta: false, ctrl: true })
  })

  it('refuses Command and MacCtrl away from macOS', () => {
    expect(toBinding('Command+Y', 'linux')).toBeNull()
    expect(toBinding('MacCtrl+Y', 'win32')).toBeNull()
  })

  it('refuses junk', () => {
    for (const text of ['', 'Ctrl', 'Ctrl+', 'Ctrl+Ctrl+Y', 'Ctrl+Command+Y', 'Super+Y', 'Ctrl+MediaPlayPause', 'Ctrl+F13', 'Ctrl+Tab', 'Ctrl+Enter', 'Ctrl+/', 'Ctrl+ab']) {
      expect(toBinding(text, 'darwin'), text).toBeNull()
    }
    expect(toBinding('Ctrl+Command+Y', 'linux')).toBeNull()
  })
})

describe('toChromeText', () => {
  it('writes the manifest grammar back, in Chrome\'s order', () => {
    expect(toChromeText('Mod+Shift+Y', 'linux')).toBe('Ctrl+Shift+Y')
    expect(toChromeText('Mod+Alt+Shift+K', 'win32')).toBe('Ctrl+Alt+Shift+K')
    expect(toChromeText('Alt+Shift+K', 'linux')).toBe('Alt+Shift+K')
    expect(toChromeText('Mod+,', 'linux')).toBe('Ctrl+Comma')
    expect(toChromeText('Alt+PageUp', 'linux')).toBe('Alt+PageUp')
    expect(toChromeText('nonsense', 'linux')).toBeNull()
  })

  it('names the macOS keys so the text reads back', () => {
    expect(toChromeText('Mod+Shift+Y', 'darwin')).toBe('Command+Shift+Y')
    expect(toChromeText('Ctrl+Shift+Y', 'darwin')).toBe('MacCtrl+Shift+Y')
    for (const text of ['Ctrl+Shift+Y', 'Alt+Shift+K', 'Ctrl+Alt+Comma']) {
      for (const platform of ['linux', 'darwin'] as const) {
        const binding = toBinding(text, platform) as string
        expect(toBinding(toChromeText(binding, platform) as string, platform), `${text} on ${platform}`).toBe(binding)
      }
    }
  })
})

describe('parseCommands', () => {
  it('lists the commands in manifest order with their kind and suggestion', () => {
    const manifest = {
      commands: {
        _execute_action: { suggested_key: { default: 'Ctrl+Shift+Y', mac: 'Command+Shift+Y' } },
        mark: { suggested_key: 'Alt+Shift+K', description: 'Mark it' },
        plain: { description: 'No key' },
        _execute_side_panel: {}
      }
    }
    expect(parseCommands(manifest, 'linux')).toEqual([
      { name: '_execute_action', description: '', kind: 'action', suggested: 'Mod+Shift+Y' },
      { name: 'mark', description: 'Mark it', kind: 'named', suggested: 'Alt+Shift+K' },
      { name: 'plain', description: 'No key', kind: 'named', suggested: null },
      { name: '_execute_side_panel', description: '', kind: 'side-panel', suggested: null }
    ])
  })

  it('treats the three action command names alike', () => {
    const kinds = parseCommands({ commands: { _execute_action: {}, _execute_browser_action: {}, _execute_page_action: {} } }, 'linux').map((command) => command.kind)
    expect(kinds).toEqual(['action', 'action', 'action'])
  })

  it('picks the platform\'s own key, then the default', () => {
    const manifest = { commands: { a: { suggested_key: { windows: 'Alt+W', linux: 'Alt+L', mac: 'Alt+M', default: 'Alt+D' } }, b: { suggested_key: { mac: 'Alt+M', default: 'Alt+D' } } } }
    expect(parseCommands(manifest, 'win32').map((c) => c.suggested)).toEqual(['Alt+W', 'Alt+D'])
    expect(parseCommands(manifest, 'linux').map((c) => c.suggested)).toEqual(['Alt+L', 'Alt+D'])
    expect(parseCommands(manifest, 'darwin').map((c) => c.suggested)).toEqual(['Alt+M', 'Alt+M'])
  })

  it('drops a suggestion Orivon would refuse for any binding', () => {
    const manifest = { commands: { bare: { suggested_key: 'Shift+K' }, edit: { suggested_key: 'Ctrl+C' }, junk: { suggested_key: 'Hyper+K' } } }
    expect(parseCommands(manifest, 'linux').map((c) => c.suggested)).toEqual([null, null, null])
  })

  it('tolerates a manifest with no commands or a damaged one', () => {
    expect(parseCommands({}, 'linux')).toEqual([])
    expect(parseCommands(null, 'linux')).toEqual([])
    expect(parseCommands({ commands: [] }, 'linux')).toEqual([])
    expect(parseCommands({ commands: { a: 'x', b: null, c: { description: 5, suggested_key: 5 } } }, 'linux')).toEqual([
      { name: 'c', description: '', kind: 'named', suggested: null }
    ])
  })
})

function set (id: string, commands: Record<string, unknown>, chosen: Record<string, string> = {}): ExtensionCommandSet {
  return { id, name: `Ext ${id}`, commands: parseCommands({ commands }, 'linux'), chosen }
}

describe('resolveBindings', () => {
  const free = (): boolean => false
  const bindings = (entries: CommandEntry[]): Array<string | null> => entries.map((entry) => entry.binding)

  it('binds a free suggestion', () => {
    const entries = resolveBindings([set('a', { go: { suggested_key: 'Alt+Shift+K' } })], 'linux', free)
    expect(bindings(entries)).toEqual(['Alt+Shift+K'])
    expect(entries[0]?.suggestedBlocked).toBe(false)
  })

  it('lets a chosen key beat the suggestion, and \'\' keep a command unbound', () => {
    const entries = resolveBindings([
      set('a', { go: { suggested_key: 'Alt+Shift+K' }, stop: { suggested_key: 'Alt+Shift+J' } }, { go: 'Mod+Shift+U', stop: '' })
    ], 'linux', free)
    expect(bindings(entries)).toEqual(['Mod+Shift+U', null])
    expect(entries[1]?.suggestedBlocked).toBe(false)
  })

  it('leaves a suggestion unbound when Orivon holds the key, and says so', () => {
    const entries = resolveBindings([set('a', { clash: { suggested_key: 'Ctrl+T' } })], 'linux', (c) => c.key === 't' && c.ctrl)
    expect(bindings(entries)).toEqual([null])
    expect(entries[0]?.suggestedBlocked).toBe(true)
  })

  it('gives a key to the first installed command that wants it', () => {
    const entries = resolveBindings([
      set('a', { one: { suggested_key: 'Alt+Shift+K' } }),
      set('b', { two: { suggested_key: 'Alt+Shift+K' }, three: { suggested_key: 'Alt+Shift+L' } })
    ], 'linux', free)
    expect(bindings(entries)).toEqual(['Alt+Shift+K', null, 'Alt+Shift+L'])
    expect(entries[1]?.suggestedBlocked).toBe(true)
  })

  it('lets a later extension\'s own choice beat an earlier extension\'s suggestion', () => {
    const entries = resolveBindings([
      set('a', { one: { suggested_key: 'Alt+Shift+K' } }),
      set('b', { two: {} }, { two: 'Alt+Shift+K' })
    ], 'linux', free)
    expect(bindings(entries)).toEqual([null, 'Alt+Shift+K'])
  })

  it('ignores a chosen key that is no longer allowed, and one Orivon now holds', () => {
    const entries = resolveBindings([
      set('a', { one: {}, two: {}, three: {} }, { one: 'Shift+K', two: 'Mod+C', three: 'Mod+T' })
    ], 'linux', (c) => c.key === 't')
    expect(bindings(entries)).toEqual([null, null, null])
  })

  it('does not treat a command named like an object member as chosen', () => {
    const entries = resolveBindings([set('a', { constructor: { suggested_key: 'Alt+Shift+K' } })], 'linux', free)
    expect(bindings(entries)).toEqual(['Alt+Shift+K'])
  })
})

describe('assign', () => {
  const table = resolveBindings([
    set('a', { one: { suggested_key: 'Alt+Shift+K', description: 'First' } }),
    set('b', { two: {} })
  ], 'linux', () => false)
  const none = (): string | null => null
  const target = { extensionId: 'b', name: 'two' }

  it('accepts a free key', () => {
    expect(assign(table, target, chord('Mod+Shift+U'), 'linux', none)).toEqual({ status: 'ok', binding: 'Mod+Shift+U' })
  })

  it('accepts the key the command already holds', () => {
    expect(assign(table, { extensionId: 'a', name: 'one' }, chord('Alt+Shift+K'), 'linux', none).status).toBe('ok')
  })

  it('refuses a key with no modifier, a reserved key and a key no manifest could name', () => {
    expect(assign(table, target, chord('Shift+K'), 'linux', none)).toEqual({ status: 'invalid', problem: 'needs-modifier' })
    expect(assign(table, target, chord('Mod+C'), 'linux', none)).toEqual({ status: 'invalid', problem: 'reserved' })
    expect(assign(table, target, chord('Mod+Tab'), 'linux', none)).toEqual({ status: 'invalid', problem: 'unsupported' })
    expect(assign(table, target, chord('Mod+F13'), 'linux', none)).toEqual({ status: 'invalid', problem: 'unsupported' })
    expect(assign(table, target, chord('Meta+K'), 'linux', none)).toEqual({ status: 'invalid', problem: 'unsupported' })
  })

  it('names the Orivon command that holds the key', () => {
    expect(assign(table, target, chord('Mod+T'), 'linux', () => 'New tab')).toEqual({ status: 'orivon', binding: 'Mod+T', label: 'New tab' })
  })

  it('names the extension command that holds the key', () => {
    expect(assign(table, target, chord('Alt+Shift+K'), 'linux', none)).toEqual({
      status: 'extension',
      binding: 'Alt+Shift+K',
      holder: { extensionId: 'a', extensionName: 'Ext a', name: 'one', description: 'First' }
    })
  })

  it('checks Orivon before another extension', () => {
    expect(assign(table, target, chord('Alt+Shift+K'), 'linux', () => 'Something').status).toBe('orivon')
  })
})
