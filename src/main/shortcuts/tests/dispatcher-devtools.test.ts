import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { attachShortcuts } from '../dispatcher.js'
import type { PressedKey } from '../dispatcher.js'
import { ShortcutService } from '../shortcut-service.js'
import { ShortcutStore } from '../shortcut-store.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'orivon-dispatcher-devtools-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const key = (k: string, code: string, mods: Partial<PressedKey> = {}): PressedKey =>
  ({ type: 'keyDown', key: k, code, control: false, alt: false, shift: false, meta: false, isAutoRepeat: false, isComposing: false, ...mods })

async function press (input: PressedKey): Promise<{ run: ReturnType<typeof vi.fn>, event: { preventDefault: ReturnType<typeof vi.fn> }, afterEvent: () => Promise<void> }> {
  const store = new ShortcutStore(join(dir, 'shortcuts.json'), 'linux')
  await store.load()
  const contents = new EventEmitter() as WebContents & EventEmitter
  const run = vi.fn()
  attachShortcuts(contents, new ShortcutService(store, 'linux'), { windowFor: () => ({ suspended: false, isAppTab: false, run }), recorded: vi.fn() })
  const event = { preventDefault: vi.fn() }
  contents.emit('before-input-event', event, input)
  return { run, event, afterEvent: async () => { await new Promise<void>((resolve) => { setImmediate(resolve) }) } }
}

// Closing the tools from inside the key event destroys a webContents Chromium may still be notifying observers
// on, which ends the main process (a CHECK in ~WebContentsImpl, or "Object has been destroyed").
it('runs the developer tools commands once the key event has returned, and keeps the key from the page', async () => {
  const { run, event, afterEvent } = await press(key('F12', 'F12'))
  expect(event.preventDefault).toHaveBeenCalledTimes(1)
  expect(run).not.toHaveBeenCalled()
  await afterEvent()
  expect(run).toHaveBeenCalledExactlyOnceWith('devtools.toggle')
})

it('runs the JavaScript console command after the event too', async () => {
  const { run, afterEvent } = await press(key('J', 'KeyJ', { control: true, shift: true }))
  expect(run).not.toHaveBeenCalled()
  await afterEvent()
  expect(run).toHaveBeenCalledExactlyOnceWith('devtools.console')
})

it('still runs every other command inside the event', async () => {
  const { run } = await press(key('t', 'KeyT', { control: true }))
  expect(run).toHaveBeenCalledExactlyOnceWith('tab.new')
})
