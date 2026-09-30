import { describe, expect, it, vi } from 'vitest'
import type { ShellServices } from '../../shell/shell-services.js'
import type { ShellWindow } from '../../shell/window-registry.js'
import { installDownloadsPeek } from '../auto-open.js'
import type { StartInfo } from '../download-service.js'
import { PEEK_CONTROLLERS } from '../peek-controller.js'

function rig (settings: Record<string, unknown> = { 'downloads.showBubble': true, 'toolbar.downloads': 'auto' }) {
  const send = vi.fn()
  const open = new Set<string>()
  const window = {
    chrome: { webContents: { isDestroyed: () => false, send } },
    overlays: { isOpen: (name: string) => open.has(name), close: vi.fn((name: string) => { open.delete(name) }) }
  } as unknown as ShellWindow
  let onStart: (info: StartInfo) => void = () => {}
  let onChange: (change: null) => void = () => {}
  const services = {
    settings: { get: (key: string) => settings[key] },
    downloads: {
      onStart: (next: typeof onStart) => { onStart = next },
      onChange: (next: typeof onChange) => { onChange = next },
      list: () => [], summary: () => ({ active: 1, fraction: null, any: true })
    },
    windows: { findTab: (contents: unknown) => contents === undefined ? null : { window, tabId: 't' } }
  } as unknown as ShellServices
  installDownloadsPeek(services)
  return { services, send, open, window, start: (info: object = { contents: {} }) => { onStart({ id: 'x', ...info } as unknown as StartInfo) }, change: () => { onChange(null) } }
}

describe('installDownloadsPeek', () => {
  it('asks the chrome of the window that started the download to open the peek', () => {
    const { send, start } = rig()
    start()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[1]).toEqual({ type: 'module', module: 'downloads-button', payload: { peek: true } })
  })

  it('asks for nothing when the setting is off, when the button is never shown, or when no tab started it', () => {
    for (const settings of [{ 'downloads.showBubble': false, 'toolbar.downloads': 'auto' }, { 'downloads.showBubble': true, 'toolbar.downloads': 'never' }]) {
      const made = rig(settings)
      made.start()
      expect(made.send).not.toHaveBeenCalled()
    }
    const none = rig()
    none.start({ contents: undefined })
    expect(none.send).not.toHaveBeenCalled()
  })

  it('does not open over any open popup, the main menu included', () => {
    const { send, open, start } = rig()
    open.add('menu')
    start()
    expect(send).not.toHaveBeenCalled()
  })

  it('leaves its controller where the overlay finds it, and keeps running when a list changes', () => {
    const { services, change } = rig()
    expect(PEEK_CONTROLLERS.get(services)).toBeDefined()
    expect(change).not.toThrow()
  })
})
