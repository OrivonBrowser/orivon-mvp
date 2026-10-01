import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { parseBinding } from '../accelerator.js'
import { buildAppMenuTemplate, toElectronAccelerator } from '../app-menu.js'
import { COMMANDS } from '../commands.js'
import { ShortcutService } from '../shortcut-service.js'
import { ShortcutStore } from '../shortcut-store.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'orivon-menu-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

async function service (platform: NodeJS.Platform): Promise<ShortcutService> {
  const store = new ShortcutStore(join(dir, 'shortcuts.json'), platform)
  await store.load()
  return new ShortcutService(store, platform)
}

describe('toElectronAccelerator', () => {
  it.each([
    ['Mod+Shift+T', 'darwin', 'Shift+Command+T'],
    ['Ctrl+Tab', 'darwin', 'Ctrl+Tab'],
    ['Alt+Left', 'darwin', 'Alt+Left'],
    ['F12', 'darwin', 'F12'],
    ['Mod++', 'darwin', 'Command+Plus'],
    ['Mod+,', 'darwin', 'Command+,']
  ])('spells %s on %s as %s', (binding, platform, expected) => {
    expect(toElectronAccelerator(parseBinding(binding, platform as NodeJS.Platform) as never, platform as NodeJS.Platform)).toBe(expected)
  })
})

describe('buildAppMenuTemplate', () => {
  it('is no menu at all off macOS', async () => {
    expect(buildAppMenuTemplate(await service('linux'), vi.fn())).toBeNull()
    expect(buildAppMenuTemplate(await service('win32'), vi.fn())).toBeNull()
  })

  it('on macOS keeps the roles that make editing work, and lists every command with its keys for display only', async () => {
    const run = vi.fn()
    const template = buildAppMenuTemplate(await service('darwin'), run) as MenuItemConstructorOptions[]

    expect(template.map((item) => item.role ?? item.label)).toEqual(['appMenu', 'editMenu', 'Tab', 'Go', 'Tools', 'Window', 'windowMenu'])
    const items = template.flatMap((item) => Array.isArray(item.submenu) ? item.submenu : [])
    expect(items).toHaveLength(COMMANDS.length)
    for (const item of items) expect(item.registerAccelerator).toBe(false)
    expect(items.find((item) => item.label === 'New tab')?.accelerator).toBe('Command+T')
    items.find((item) => item.label === 'Close tab')?.click?.({} as never, undefined, {} as never)
    expect(run).toHaveBeenCalledWith('tab.close')
  })

  it('shows a cleared command without a key', async () => {
    const s = await service('darwin')
    s.clear('tab.new')
    const template = buildAppMenuTemplate(s, vi.fn()) as MenuItemConstructorOptions[]

    const items = template.flatMap((item) => Array.isArray(item.submenu) ? item.submenu : [])
    expect(items.find((item) => item.label === 'New tab')).not.toHaveProperty('accelerator')
  })
})
