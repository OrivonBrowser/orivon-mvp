import { describe, expect, it, vi } from 'vitest'
import type { ShellServices } from '../../shell/shell-services.js'
import type { ShellWindow } from '../../shell/window-registry.js'
import { runCommand } from '../run-command.js'
import type { CommandDeps } from '../run-command.js'

function run (mode: string, barItems: number, options: { kiosk?: boolean } = {}): ReturnType<typeof vi.fn> {
  const set = vi.fn()
  const services = {
    kiosk: options.kiosk === true,
    settings: { get: () => mode, set },
    bookmarks: { children: () => new Array(barItems).fill({}) }
  } as unknown as ShellServices
  const target = { tabs: { getState: () => ({ tabs: [], activeTabId: null }) }, window: {}, chrome: {} } as unknown as ShellWindow
  runCommand('bookmarks.toggleBar', target, { services } as unknown as CommandDeps)
  return set
}

describe('bookmarks.toggleBar', () => {
  it('hides a shown bar and shows a hidden one by setting the mode the Settings row holds', () => {
    expect(run('always', 0)).toHaveBeenCalledWith('appearance.bookmarksBar', 'never')
    expect(run('never', 3)).toHaveBeenCalledWith('appearance.bookmarksBar', 'always')
  })

  it('counts auto as shown when the bar has an item, and as hidden when it has none', () => {
    expect(run('auto', 2)).toHaveBeenCalledWith('appearance.bookmarksBar', 'never')
    expect(run('auto', 0)).toHaveBeenCalledWith('appearance.bookmarksBar', 'always')
  })

  it('is not offered in a kiosk window', () => {
    expect(run('always', 1, { kiosk: true })).not.toHaveBeenCalled()
  })
})
