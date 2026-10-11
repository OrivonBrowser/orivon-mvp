import { describe, expect, it, vi } from 'vitest'
import type { ShellServices } from '../../shell/shell-services.js'
import type { ShellWindow } from '../../shell/window-registry.js'
import { commandById } from '../commands.js'
import { runCommand } from '../run-command.js'
import type { CommandDeps } from '../run-command.js'

function run (mode: string, options: { kiosk?: boolean } = {}): ReturnType<typeof vi.fn> {
  const set = vi.fn()
  const services = { kiosk: options.kiosk === true, settings: { get: () => mode, set } } as unknown as ShellServices
  const target = { tabs: { getState: () => ({ tabs: [], activeTabId: null }) }, window: {}, chrome: {} } as unknown as ShellWindow
  runCommand('search.toggleMode', target, { services } as unknown as CommandDeps)
  return set
}

describe('search.toggleMode', () => {
  it('is a navigation command with no key of its own, since it is the address bar chip that most people press', () => {
    expect(commandById('search.toggleMode')).toEqual({ id: 'search.toggleMode', label: 'Switch search between Web3 and Web2', category: 'navigation' })
  })

  it('flips the mode the Settings row holds, each way', () => {
    expect(run('web3')).toHaveBeenCalledWith('search.mode', 'web2')
    expect(run('web2')).toHaveBeenCalledWith('search.mode', 'web3')
  })

  it('is not offered in a kiosk window', () => {
    expect(run('web3', { kiosk: true })).not.toHaveBeenCalled()
  })
})
