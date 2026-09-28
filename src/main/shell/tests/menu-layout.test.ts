import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { commandById } from '../../shortcuts/commands.js'
import { ShortcutService } from '../../shortcuts/shortcut-service.js'
import { ShortcutStore } from '../../shortcuts/shortcut-store.js'
import { MENU_LAYOUT, menuItems } from '../menu-layout.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'orivon-menu-layout-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

async function service (): Promise<ShortcutService> {
  const store = new ShortcutStore(join(dir, 'shortcuts.json'), 'linux')
  await store.load()
  return new ShortcutService(store, 'linux')
}

describe('the main menu', () => {
  it('lists only commands that exist, and never starts, ends or doubles a separator', () => {
    for (const entry of MENU_LAYOUT) if (entry !== '-') expect(commandById(entry), entry).toBeDefined()
    expect(MENU_LAYOUT[0]).not.toBe('-')
    expect(MENU_LAYOUT.at(-1)).not.toBe('-')
    MENU_LAYOUT.forEach((entry, at) => { if (entry === '-') expect(MENU_LAYOUT[at - 1]).not.toBe('-') })
  })

  it('shows each command under the keys it has now', async () => {
    const shortcuts = await service()
    const before = menuItems(shortcuts).find((item) => item.kind === 'command' && item.id === 'tab.new')
    expect(before).toMatchObject({ label: 'New tab', keys: ['Ctrl', 'T'] })

    shortcuts.set('tab.new', 'Ctrl+Shift+Y')

    const after = menuItems(shortcuts).find((item) => item.kind === 'command' && item.id === 'tab.new')
    expect(after).toMatchObject({ keys: ['Ctrl', 'Shift', 'Y'] })
  })

  it('shows no keys for a command the person cleared', async () => {
    const shortcuts = await service()
    shortcuts.clear('bookmark.toggle')
    expect(menuItems(shortcuts).find((item) => item.kind === 'command' && item.id === 'bookmark.toggle')).toMatchObject({ keys: null })
  })
})
