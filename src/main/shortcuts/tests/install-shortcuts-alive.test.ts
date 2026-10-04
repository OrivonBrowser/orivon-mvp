// A command waiting for the end of its key event is dropped when the window it was meant for is closing, not only
// once it is destroyed: between the window's `close` and `closed` its tabs are already disposed, and a command that
// opens a tab would build one nothing ever closes.
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { PressedKey } from '../dispatcher.js'
import { ShortcutService } from '../shortcut-service.js'
import { ShortcutStore } from '../shortcut-store.js'

vi.mock('electron', () => ({ ipcMain: { on: vi.fn(), handle: vi.fn() }, Menu: { setApplicationMenu: vi.fn() } }))
const { installShortcuts } = await import('../install-shortcuts.js')

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'orivon-install-shortcuts-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const ctrlT: PressedKey = { type: 'keyDown', key: 't', code: 'KeyT', control: true, alt: false, shift: false, meta: false, isAutoRepeat: false, isComposing: false }

async function pressInWindow (state: { destroyed: boolean, disposed: boolean }): Promise<ReturnType<typeof vi.fn>> {
  const store = new ShortcutStore(join(dir, 'shortcuts.json'), 'linux')
  await store.load()
  const owner = {
    window: { isDestroyed: () => state.destroyed },
    chromeHeight: () => 76,
    shortcutsSuspended: () => false,
    tabs: { findTabIdByWebContents: () => null, record: () => undefined, isDisposed: () => state.disposed }
  }
  const windows = { findOwner: () => owner, focused: () => owner }
  const run = vi.fn()
  let created: ((event: unknown, contents: unknown) => void) | undefined
  const app = { on: (_event: string, handler: (event: unknown, contents: unknown) => void) => { created = handler } }
  installShortcuts(app as never, new ShortcutService(store, 'linux'), windows as never, { run } as never)
  const contents = Object.assign(new EventEmitter(), { getType: () => 'window' }) as unknown as WebContents & EventEmitter
  created?.({}, contents)
  contents.emit('before-input-event', { preventDefault: vi.fn() }, ctrlT)
  await new Promise<void>((resolve) => { setImmediate(resolve) })
  return run
}

it('runs a deferred command while its window is open', async () => {
  const run = await pressInWindow({ destroyed: false, disposed: false })
  expect(run).toHaveBeenCalledExactlyOnceWith('tab.new', expect.anything())
})

it('drops a deferred command once the window is closing and its tabs are disposed', async () => {
  const run = await pressInWindow({ destroyed: false, disposed: true })
  expect(run).not.toHaveBeenCalled()
})

it('drops a deferred command once the window is destroyed', async () => {
  const run = await pressInWindow({ destroyed: true, disposed: true })
  expect(run).not.toHaveBeenCalled()
})
