import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyThemeSetting } from '../settings-appliers.js'
import { SettingsStore } from '../settings-store.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'orivon-appliers-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('applyThemeSetting', () => {
  it('puts the OS theme on the chosen value at once, and follows each change', async () => {
    const store = new SettingsStore(join(dir, 'settings.json'))
    await store.load()
    store.set('appearance.theme', 'dark')
    const theme = { themeSource: 'system' as 'system' | 'light' | 'dark' }

    applyThemeSetting(store, theme)
    expect(theme.themeSource).toBe('dark')

    store.set('appearance.theme', 'light')
    expect(theme.themeSource).toBe('light')
    store.reset('appearance.theme')
    expect(theme.themeSource).toBe('system')
  })

  it('leaves the theme alone for a change to some other setting, and after it is removed', async () => {
    const store = new SettingsStore(join(dir, 'settings.json'))
    await store.load()
    const theme = { themeSource: 'system' as 'system' | 'light' | 'dark' }
    const stop = applyThemeSetting(store, theme)

    store.set('tabs.lastTabClosed', 'newTab')
    expect(theme.themeSource).toBe('system')

    stop()
    store.set('appearance.theme', 'dark')
    expect(theme.themeSource).toBe('system')
  })
})
