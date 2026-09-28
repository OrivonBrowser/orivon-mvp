import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { attachShortcuts } from '../dispatcher.js'
import type { PressedKey } from '../dispatcher.js'
import { ShortcutService } from '../shortcut-service.js'
import { ShortcutStore } from '../shortcut-store.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'orivon-dispatcher-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const key = (k: string, code: string, mods: Partial<PressedKey> = {}): PressedKey =>
  ({ type: 'keyDown', key: k, code, control: false, alt: false, shift: false, meta: false, isAutoRepeat: false, isComposing: false, ...mods })

async function setup (options: { windowless?: boolean, suspended?: boolean } = {}): Promise<{
  contents: WebContents & EventEmitter
  service: ShortcutService
  run: ReturnType<typeof vi.fn>
  recorded: ReturnType<typeof vi.fn>
  press: (input: PressedKey) => { preventDefault: ReturnType<typeof vi.fn> }
}> {
  const store = new ShortcutStore(join(dir, 'shortcuts.json'), 'linux')
  await store.load()
  const service = new ShortcutService(store, 'linux')
  const contents = new EventEmitter() as WebContents & EventEmitter
  const run = vi.fn()
  const recorded = vi.fn()
  const resolved = options.windowless === true ? null : { suspended: options.suspended === true, run }
  attachShortcuts(contents, service, { windowFor: () => resolved, recorded })
  return {
    contents, service, run, recorded,
    press: (input) => {
      const event = { preventDefault: vi.fn() }
      contents.emit('before-input-event', event, input)
      return event
    }
  }
}

describe('attachShortcuts', () => {
  it('runs the command a chord is bound to, and keeps the key from the page', async () => {
    const { press, run } = await setup()

    const event = press(key('t', 'KeyT', { control: true }))

    expect(run).toHaveBeenCalledExactlyOnceWith('tab.new')
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
  })

  it('leaves alone a key that is bound to nothing, a key release, a modifier on its own, and composition', async () => {
    const { press, run } = await setup()

    const events = [
      press(key('q', 'KeyQ', { control: true, alt: true })),
      press(key('t', 'KeyT', { control: true, type: 'keyUp' })),
      press(key('Control', 'ControlLeft', { control: true })),
      press(key('t', 'KeyT', { control: true, isComposing: true }))
    ]

    expect(run).not.toHaveBeenCalled()
    for (const event of events) expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('swallows the repeats of a command that should not repeat, and lets one that should repeat', async () => {
    const { press, run } = await setup()

    const held = press(key('t', 'KeyT', { control: true, isAutoRepeat: true }))
    expect(held.preventDefault).toHaveBeenCalledTimes(1)
    expect(run).not.toHaveBeenCalled()

    press(key('Tab', 'Tab', { control: true, isAutoRepeat: true }))
    expect(run).toHaveBeenCalledExactlyOnceWith('tab.next')
  })

  it('does nothing while a page has the screen, and the page keeps the key', async () => {
    const { press, run } = await setup({ suspended: true })

    const event = press(key('t', 'KeyT', { control: true }))

    expect(run).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('does nothing for a view in no window', async () => {
    const { press, run } = await setup({ windowless: true })

    expect(press(key('t', 'KeyT', { control: true })).preventDefault).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('takes the next chord as the answer while recording, and reports it to the page', async () => {
    const { press, run, recorded, service, contents } = await setup()
    service.beginRecording(contents, 'tab.new')

    const modifier = press(key('Control', 'ControlLeft', { control: true }))
    const chord = press(key('y', 'KeyY', { control: true, alt: true }))

    expect(modifier.preventDefault).not.toHaveBeenCalled()
    expect(chord.preventDefault).toHaveBeenCalledTimes(1)
    expect(run).not.toHaveBeenCalled()
    expect(recorded).toHaveBeenCalledExactlyOnceWith(contents, { commandId: 'tab.new', result: { status: 'ok' }, binding: 'Mod+Alt+Y' })
  })

  it('records the chord of a command already bound rather than running it', async () => {
    const { press, run, service, contents, recorded } = await setup()
    service.beginRecording(contents, 'tab.new')

    press(key('w', 'KeyW', { control: true }))

    expect(run).not.toHaveBeenCalled()
    expect(recorded.mock.calls[0]?.[1]).toMatchObject({ result: { status: 'conflict', with: 'tab.close' } })
  })

  it('runs commands as usual again once the recording is over', async () => {
    const { press, run, service, contents } = await setup()
    service.beginRecording(contents, 'tab.new')
    press(key('Escape', 'Escape'))

    press(key('w', 'KeyW', { control: true }))

    expect(run).toHaveBeenCalledExactlyOnceWith('tab.close')
  })
})
