import { describe, expect, it, vi } from 'vitest'
import { SHELL_EVENT_CHANNEL } from '../../channels.js'
import type { ShellServices } from '../../shell/shell-services.js'
import type { ShellWindow } from '../../shell/window-registry.js'
import { runCommand } from '../run-command.js'
import type { CommandDeps } from '../run-command.js'

// What the keyboard commands do to a window: the pane keys move web-contents focus, caret browsing flips its setting.
function harness (chromeFocused: boolean, settings: Record<string, boolean> = {}): { target: ShellWindow, deps: CommandDeps, chromeFocus: ReturnType<typeof vi.fn>, pageFocus: ReturnType<typeof vi.fn>, send: ReturnType<typeof vi.fn>, set: ReturnType<typeof vi.fn>, shown: ReturnType<typeof vi.fn> } {
  const chromeFocus = vi.fn()
  const pageFocus = vi.fn()
  const send = vi.fn()
  const shown = vi.fn()
  const set = vi.fn()
  const target = {
    window: {},
    chrome: { webContents: { focus: chromeFocus, send, isFocused: () => chromeFocused, isDestroyed: () => false } },
    tabs: { getState: () => ({ tabs: [], activeTabId: null }), activeWebContents: () => ({ focus: pageFocus }) },
    overlays: { show: shown, toggle: vi.fn(), isOpen: () => false, close: vi.fn(), send: vi.fn() },
    shortcutsSuspended: () => false
  } as unknown as ShellWindow
  const deps = { services: { kiosk: false, settings: { get: (key: string) => settings[key], set } } as unknown as ShellServices, openWindow: vi.fn(), displays: () => [], quit: vi.fn() } satisfies CommandDeps
  return { target, deps, chromeFocus, pageFocus, send, set, shown }
}

const panes = (payload: unknown): unknown => ({ type: 'module', module: 'panes', payload })

describe('the pane commands', () => {
  it('takes the chrome from the page and goes in at its first pane (F6) or its last (Shift+F6)', () => {
    const { target, deps, chromeFocus, send } = harness(false)
    runCommand('focus.nextPane', target, deps)
    runCommand('focus.previousPane', target, deps)
    expect(chromeFocus).toHaveBeenCalledTimes(2)
    expect(send.mock.calls).toEqual([[SHELL_EVENT_CHANNEL, panes({ type: 'enter', edge: 'first' })], [SHELL_EVENT_CHANNEL, panes({ type: 'enter', edge: 'last' })]])
  })

  it('leaves a step inside the chrome to the chrome', () => {
    const { target, deps, chromeFocus, send } = harness(true)
    runCommand('focus.nextPane', target, deps)
    expect(chromeFocus).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith(SHELL_EVENT_CHANNEL, panes({ type: 'step', direction: 1 }))
  })

  it('names the toolbar for its own key', () => {
    const { target, deps, chromeFocus, send } = harness(false)
    runCommand('focus.toolbar', target, deps)
    expect(chromeFocus).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(SHELL_EVENT_CHANNEL, panes({ type: 'go', pane: 'toolbar' }))
  })
})

describe('the caret browsing command', () => {
  it('turns the setting on at once when it is not to ask, and says so', () => {
    const { target, deps, set, shown } = harness(false, { 'accessibility.caretBrowsing': false, 'accessibility.caretAsk': false })
    runCommand('caret.toggle', target, deps)
    expect(set).toHaveBeenCalledWith('accessibility.caretBrowsing', true)
    expect(shown).toHaveBeenCalledWith('toast', undefined, { code: 'caretOn' })
  })

  it('turns it off at once, even when it asks before turning on', () => {
    const { target, deps, set, shown } = harness(false, { 'accessibility.caretBrowsing': true, 'accessibility.caretAsk': true })
    runCommand('caret.toggle', target, deps)
    expect(set).toHaveBeenCalledWith('accessibility.caretBrowsing', false)
    expect(shown).toHaveBeenCalledWith('toast', undefined, { code: 'caretOff' })
  })

  it('shows the question instead of changing the setting when it asks', () => {
    const { target, deps, set } = harness(false, { 'accessibility.caretBrowsing': false, 'accessibility.caretAsk': true })
    runCommand('caret.toggle', target, deps)
    expect(set).not.toHaveBeenCalled()
  })
})
