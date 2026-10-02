import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { attachShortcuts } from '../dispatcher.js'
import type { ExtensionKeys, PressedKey } from '../dispatcher.js'
import { ShortcutService } from '../shortcut-service.js'
import { ShortcutStore } from '../shortcut-store.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'orivon-dispatcher-ext-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

// A command runs on the turn after the key event.
const settle = async (): Promise<void> => { await new Promise<void>((resolve) => { setImmediate(resolve) }) }
const key = (k: string, code: string, mods: Partial<PressedKey> = {}): PressedKey =>
  ({ type: 'keyDown', key: k, code, control: false, alt: false, shift: false, meta: false, isAutoRepeat: false, isComposing: false, ...mods })

async function setup (options: { suspended?: boolean, windowless?: boolean, appTab?: boolean, holds?: string[], runs?: boolean } = {}) {
  const store = new ShortcutStore(join(dir, 'shortcuts.json'), 'linux')
  await store.load()
  const service = new ShortcutService(store, 'linux')
  const contents = new EventEmitter() as WebContents & EventEmitter
  const run = vi.fn()
  const record = vi.fn()
  const extensionRun = vi.fn(() => options.runs !== false)
  let recording = false
  const extensionKeys: ExtensionKeys = {
    isRecording: () => recording,
    record,
    handles: (chord) => (options.holds ?? ['y']).includes(chord.key),
    run: extensionRun
  }
  const resolved = options.windowless === true ? null : { suspended: options.suspended === true, isAppTab: options.appTab === true, run }
  attachShortcuts(contents, service, { windowFor: () => resolved, recorded: vi.fn(), extensionKeys })
  return {
    run, record, extensionRun, service, startRecording: () => { recording = true },
    press: (input: PressedKey) => {
      const event = { preventDefault: vi.fn() }
      contents.emit('before-input-event', event, input)
      return event
    }
  }
}

describe('extension keys in the dispatcher', () => {
  it('runs an extension command for a chord no Orivon command holds, and keeps it from the page', async () => {
    const { press, extensionRun, run } = await setup()
    const event = press(key('Y', 'KeyY', { control: true, shift: true }))
    expect(extensionRun).toHaveBeenCalledTimes(1)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('lets Orivon\'s own command win and never asks the extension', async () => {
    const { press, extensionRun, run } = await setup({ holds: ['t'] })
    const event = press(key('t', 'KeyT', { control: true }))
    await settle()
    expect(run).toHaveBeenCalledWith('tab.new')
    expect(extensionRun).not.toHaveBeenCalled()
    expect(event.preventDefault).toHaveBeenCalled()
  })

  it('leaves the key to the page when the extension did not run anything', async () => {
    const { press, extensionRun } = await setup({ runs: false })
    const event = press(key('Y', 'KeyY', { control: true, shift: true }))
    expect(extensionRun).toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('leaves a registered app\'s tab its own keys, and tells the extension nothing', async () => {
    const { press, extensionRun } = await setup({ appTab: true })
    const event = press(key('Y', 'KeyY', { control: true, shift: true }))
    expect(extensionRun).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('ignores a chord no extension holds', async () => {
    const { press, extensionRun } = await setup({ holds: [] })
    const event = press(key('Y', 'KeyY', { control: true, shift: true }))
    expect(extensionRun).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('ignores a window that holds the screen, and a view in no window', async () => {
    for (const options of [{ suspended: true }, { windowless: true }]) {
      const { press, extensionRun } = await setup(options)
      expect(press(key('Y', 'KeyY', { control: true, shift: true })).preventDefault).not.toHaveBeenCalled()
      expect(extensionRun).not.toHaveBeenCalled()
    }
  })

  it('never repeats an extension command while the key is held', async () => {
    const { press, extensionRun } = await setup()
    const event = press(key('Y', 'KeyY', { control: true, shift: true, isAutoRepeat: true }))
    expect(extensionRun).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('hands the next chord to a page that is recording, before any command', async () => {
    const { press, record, run, extensionRun, startRecording } = await setup()
    startRecording()
    const event = press(key('t', 'KeyT', { control: true }))
    expect(record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ key: 't', ctrl: true }))
    expect(event.preventDefault).toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    expect(extensionRun).not.toHaveBeenCalled()
  })

  it('keeps waiting through a modifier pressed alone while recording', async () => {
    const { press, record, startRecording } = await setup()
    startRecording()
    const event = press(key('Control', 'ControlLeft', { control: true }))
    expect(record).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('works unchanged without extension keys', async () => {
    const store = new ShortcutStore(join(dir, 'shortcuts2.json'), 'linux')
    await store.load()
    const service = new ShortcutService(store, 'linux')
    const contents = new EventEmitter() as WebContents & EventEmitter
    const run = vi.fn()
    attachShortcuts(contents, service, { windowFor: () => ({ suspended: false, isAppTab: false, run }), recorded: vi.fn() })
    const event = { preventDefault: vi.fn() }
    contents.emit('before-input-event', event, key('t', 'KeyT', { control: true }))
    await settle()
    expect(run).toHaveBeenCalledWith('tab.new')
    contents.emit('before-input-event', event, key('Y', 'KeyY', { control: true, shift: true }))
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
  })
})
