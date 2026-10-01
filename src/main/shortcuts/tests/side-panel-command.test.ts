import { describe, expect, it, vi } from 'vitest'
import type { ShellWindow } from '../../shell/window-registry.js'
import type { ShellServices } from '../../shell/shell-services.js'
import { COMMANDS } from '../commands.js'
import { runCommand } from '../run-command.js'

const toggle = vi.hoisted(() => vi.fn())
vi.mock('../../side-panel/side-panel-host.js', () => ({ sidePanelFor: () => ({ toggle }) }))

const target = { window: {}, chrome: {}, tabs: { getState: () => ({ tabs: [], activeTabId: null }) } } as unknown as ShellWindow
const deps = (kiosk: boolean) => ({ services: { kiosk } as unknown as ShellServices, openWindow: vi.fn(), displays: () => [], quit: vi.fn() })

describe('sidePanel.toggle', () => {
  it('is a working command on Mod+Alt+B', () => {
    expect(COMMANDS.find((command) => command.id === 'sidePanel.toggle')).toMatchObject({ default: 'Mod+Alt+B', category: 'window' })
    expect(COMMANDS.find((command) => command.id === 'sidePanel.toggle')).not.toHaveProperty('pending')
  })

  it('toggles the panel of the window it was pressed in', () => {
    runCommand('sidePanel.toggle', target, deps(false))
    expect(toggle).toHaveBeenCalledTimes(1)
  })

  it('does nothing in a kiosk', () => {
    toggle.mockClear()
    runCommand('sidePanel.toggle', target, deps(true))
    expect(toggle).not.toHaveBeenCalled()
  })
})
