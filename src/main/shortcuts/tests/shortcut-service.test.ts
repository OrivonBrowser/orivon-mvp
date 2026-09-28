import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chordFromInput, parseBinding } from '../accelerator.js'
import type { KeyInput } from '../accelerator.js'
import { COMMANDS } from '../commands.js'
import type { CommandDef } from '../commands.js'
import { ShortcutService } from '../shortcut-service.js'
import { ShortcutStore } from '../shortcut-store.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'orivon-shortcut-service-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

async function service (platform: NodeJS.Platform = 'linux'): Promise<ShortcutService> {
  const store = new ShortcutStore(join(dir, 'shortcuts.json'), platform)
  await store.load()
  return new ShortcutService(store, platform)
}

const chord = (text: string, platform: NodeJS.Platform = 'linux'): NonNullable<ReturnType<typeof parseBinding>> => parseBinding(text, platform) as never
const press = (key: string, code: string, mods: Partial<Pick<KeyInput, 'control' | 'alt' | 'shift' | 'meta'>> = {}): ReturnType<typeof chordFromInput> =>
  chordFromInput({ key, code, control: false, alt: false, shift: false, meta: false, ...mods })

describe('the commands', () => {
  it('give every command a default that parses and passes the rules, and no two commands the same chord', async () => {
    const s = await service()
    const seen = new Map<string, string>()
    for (const def of COMMANDS as readonly CommandDef[]) {
      const chords = [s.primary(def.id), ...(def.aliases ?? []).map((text) => parseBinding(text, 'linux'))]
      for (const c of chords) {
        if (c === null) continue
        const id = JSON.stringify(c)
        expect(seen.get(id), `${def.id} shares a chord with ${seen.get(id) ?? ''}`).toBeUndefined()
        seen.set(id, def.id)
      }
    }
  })
})

describe('ShortcutService: which command a key runs', () => {
  it('runs a command by its default binding and by its fixed aliases', async () => {
    const s = await service()

    expect(s.commandFor(press('t', 'KeyT', { control: true }) as never)).toBe('tab.new')
    expect(s.commandFor(press('F5', 'F5') as never)).toBe('nav.reload')
    expect(s.commandFor(press('r', 'KeyR', { control: true }) as never)).toBe('nav.reload')
    expect(s.commandFor(press('F4', 'F4', { control: true }) as never)).toBe('tab.close')
  })

  it('reads Mod as the command key on macOS, and gives macOS its own defaults where they differ', async () => {
    const s = await service('darwin')

    expect(s.commandFor(press('t', 'KeyT', { meta: true }) as never)).toBe('tab.new')
    expect(s.commandFor(press('t', 'KeyT', { control: true }) as never)).toBeNull()
    expect(s.commandFor(press('[', 'BracketLeft', { meta: true }) as never)).toBe('nav.back')
  })

  it('runs a tab by its number on any layout', async () => {
    const s = await service()

    expect(s.commandFor(press('&', 'Digit1', { control: true }) as never)).toBe('tab.goto1')
    expect(s.commandFor(press('9', 'Digit9', { control: true }) as never)).toBe('tab.gotoLast')
  })

  it('runs nothing for a chord nothing is bound to', async () => {
    expect((await service()).commandFor(press('q', 'KeyQ', { control: true, alt: true }) as never)).toBeNull()
  })

  it('knows which commands repeat while a key is held', async () => {
    const s = await service()

    expect(s.isRepeatable('tab.next')).toBe(true)
    expect(s.isRepeatable('tab.new')).toBe(false)
  })
})

describe('ShortcutService: changing a binding', () => {
  it('moves a command to its new chord and takes it off the old one', async () => {
    const s = await service()

    expect(s.set('tab.new', 'Mod+Alt+T')).toEqual({ status: 'ok' })

    expect(s.commandFor(press('t', 'KeyT', { control: true, alt: true }) as never)).toBe('tab.new')
    expect(s.commandFor(press('t', 'KeyT', { control: true }) as never)).toBeNull()
    expect(s.rows().find((row) => row.id === 'tab.new')).toMatchObject({ keys: ['Ctrl', 'Alt', 'T'], isDefault: false })
  })

  it('counts a command as default again once it is set back to it', async () => {
    const s = await service()
    s.set('tab.new', 'Mod+Alt+T')

    s.set('tab.new', 'Mod+T')

    expect(s.rows().find((row) => row.id === 'tab.new')?.isDefault).toBe(true)
  })

  it.each([
    ['tab.new', 'T', 'needs-modifier'],
    ['tab.new', 'Mod+C', 'reserved'],
    ['tab.new', 'Alt+F4', 'reserved'],
    ['tab.new', 'not a binding', 'unknown'],
    ['no.such.command', 'Mod+Alt+T', 'unknown']
  ])('refuses %s -> %s (%s)', async (id, binding, problem) => {
    const s = await service()

    expect(s.set(id, binding)).toEqual({ status: 'invalid', problem })
    expect(s.commandFor(press('t', 'KeyT', { control: true }) as never)).toBe('tab.new')
  })

  it('reports a conflict with the command that holds the chord, and changes nothing', async () => {
    const s = await service()

    expect(s.set('tab.new', 'Mod+W')).toEqual({ status: 'conflict', with: 'tab.close', label: 'Close tab', canSwap: true })
    expect(s.commandFor(press('w', 'KeyW', { control: true }) as never)).toBe('tab.close')
    expect(s.commandFor(press('t', 'KeyT', { control: true }) as never)).toBe('tab.new')
  })

  it('cannot trade a fixed alias, only report it', async () => {
    const s = await service()

    expect(s.set('tab.new', 'F5')).toMatchObject({ status: 'conflict', with: 'nav.reload', canSwap: false })
  })

  it('may take a chord back from itself without a conflict', async () => {
    const s = await service()

    expect(s.set('tab.close', 'Mod+W')).toEqual({ status: 'ok' })
  })

  it('swaps two commands\' bindings', async () => {
    const s = await service()

    expect(s.swap('tab.new', 'tab.close', 'Mod+W')).toEqual({ status: 'ok' })

    expect(s.commandFor(press('w', 'KeyW', { control: true }) as never)).toBe('tab.new')
    expect(s.commandFor(press('t', 'KeyT', { control: true }) as never)).toBe('tab.close')
  })

  it('leaves the other command unbound when a swap takes the chord from it and the first had none', async () => {
    const s = await service()
    s.clear('tab.new')

    expect(s.swap('tab.new', 'tab.close', 'Mod+W')).toEqual({ status: 'ok' })

    expect(s.primary('tab.close')).toBeNull()
    expect(s.commandFor(press('w', 'KeyW', { control: true }) as never)).toBe('tab.new')
  })

  it.each([
    ['a command that does not hold the chord', 'tab.new', 'nav.back', 'Mod+W'],
    ['a command with itself', 'tab.new', 'tab.new', 'Mod+T'],
    ['an unknown command', 'tab.new', 'nope', 'Mod+W'],
    ['a chord that is only an alias', 'tab.new', 'nav.reload', 'F5']
  ])('refuses to swap %s', async (_name, id, other, binding) => {
    const s = await service()

    expect(s.swap(id, other, binding)).toEqual({ status: 'invalid', problem: 'unknown' })
  })

  it('clears a binding, resets one, and resets all', async () => {
    const s = await service()
    s.clear('tab.new')
    s.set('nav.back', 'Mod+Alt+B')
    expect(s.rows().find((row) => row.id === 'tab.new')?.keys).toBeNull()

    s.reset('tab.new')
    expect(s.primary('tab.new')).toEqual(chord('Mod+T'))

    s.resetAll()
    expect(s.rows().every((row) => row.isDefault)).toBe(true)
  })

  it('tells listeners about each change', async () => {
    const s = await service()
    const listener = vi.fn()
    s.onChange(listener)

    s.set('tab.new', 'Mod+Alt+T')
    s.clear('tab.close')
    s.reset('tab.new')
    s.resetAll()
    s.set('tab.new', 'T')

    expect(listener).toHaveBeenCalledTimes(4)
  })
})

describe('ShortcutService: recording a binding', () => {
  const owner = {}

  it('waits through a modifier, then applies the chord the person presses', async () => {
    const s = await service()
    expect(s.beginRecording(owner, 'tab.new')).toBe(true)

    expect(s.recordChord(owner, null)).toBeNull()
    expect(s.isRecording(owner)).toBe(true)
    const outcome = s.recordChord(owner, press('y', 'KeyY', { control: true, alt: true }))

    expect(outcome).toEqual({ commandId: 'tab.new', result: { status: 'ok' }, binding: 'Mod+Alt+Y' })
    expect(s.isRecording(owner)).toBe(false)
    expect(s.primary('tab.new')).toEqual(chord('Mod+Alt+Y'))
  })

  it('cancels on Escape by itself, and changes nothing', async () => {
    const s = await service()
    s.beginRecording(owner, 'tab.new')

    expect(s.recordChord(owner, press('Escape', 'Escape'))).toEqual({ commandId: 'tab.new', result: { status: 'cancelled' }, binding: null })
    expect(s.primary('tab.new')).toEqual(chord('Mod+T'))
  })

  it('reports a conflict without applying it, for the page to offer the swap', async () => {
    const s = await service()
    s.beginRecording(owner, 'tab.new')

    const outcome = s.recordChord(owner, press('w', 'KeyW', { control: true }))

    expect(outcome?.result).toMatchObject({ status: 'conflict', with: 'tab.close' })
    expect(outcome?.binding).toBe('Mod+W')
    expect(s.primary('tab.new')).toEqual(chord('Mod+T'))
  })

  it('reports a chord the rules refuse', async () => {
    const s = await service()
    s.beginRecording(owner, 'tab.new')

    expect(s.recordChord(owner, press('c', 'KeyC', { control: true }))?.result).toEqual({ status: 'invalid', problem: 'reserved' })
  })

  it('ignores keys from anyone else, and refuses to record for a command that does not exist', async () => {
    const s = await service()
    s.beginRecording(owner, 'tab.new')

    expect(s.recordChord({}, press('y', 'KeyY', { control: true, alt: true }))).toBeNull()
    expect(s.isRecording(owner)).toBe(true)
    s.cancelRecording()
    expect(s.isRecording(owner)).toBe(false)
    expect(s.beginRecording(owner, 'nope')).toBe(false)
  })
})
