import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { ShellBridge } from '../extension-host-impl.js'

const ID = 'abcdefghijklmnopabcdefghijklmnop'

const SCREEN = { x: 0, y: 0, width: 1920, height: 1080 }
const DISPLAY = { id: 1, bounds: SCREEN, workArea: SCREEN }
vi.mock('electron', () => ({ screen: { getPrimaryDisplay: () => DISPLAY, getAllDisplays: () => [DISPLAY] }, session: { defaultSession: { extensions: { getExtension: vi.fn((id: string) => id === 'abcdefghijklmnopabcdefghijklmnop' ? {} : null) } } } }))
vi.mock('../../shell/window.js', () => ({ createShellWindow: vi.fn() }))
vi.mock('../../shell/window-frame.js', () => ({ MIN_WINDOW_WIDTH: 500, MIN_WINDOW_HEIGHT: 400, defaultWindowSize: () => ({ width: 1280, height: 800 }) }))

/** A fresh gate, shut, and the extension host over it: the gate's state lasts as long as its module. */
async function setup () {
  vi.resetModules()
  const gate = await import('../../startup/web-ready.js')
  const { buildHostImpl } = await import('../extension-host-impl.js')
  const { openExtensionTab } = await import('../extension-opened-pages.js')
  const { isExtensionOpened } = await import('../extension-opened-pages.js')
  const { createShellWindow } = await import('../../shell/window.js')
  return { gate, buildHostImpl, openExtensionTab, isExtensionOpened, createShellWindow }
}

const pageWith = (): WebContents => ({ on: vi.fn(), loadURL: vi.fn(async () => undefined) }) as unknown as WebContents

describe('the extension host before web pages may load', () => {
  it('has chrome.tabs.create answer with the tab it opened, after the gate opens', async () => {
    const { gate, buildHostImpl } = await setup()
    const tab = pageWith()
    const openTrusted = vi.fn((): [string, WebContents] => ['t', tab])
    const win = { id: 1, isDestroyed: () => false, isFocused: () => true }
    const bridge = { services: { windows: { focused: () => ({ window: win }), all: () => [{ window: win, tabs: { openTrusted } }] } } } as unknown as ShellBridge
    const asked = buildHostImpl(() => bridge).createTab?.({ url: 'https://example.com/' } as never)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(openTrusted).not.toHaveBeenCalled()

    gate.openWebContent()
    const opened = await asked
    expect(openTrusted).toHaveBeenCalledOnce()
    expect(opened?.[1]).toBe(win)
  })

  it('keeps an extension page it opened remembered as its own, though it opened after the gate', async () => {
    const { gate, openExtensionTab, isExtensionOpened } = await setup()
    const tab = pageWith()
    const openTrusted = vi.fn((): [string, WebContents] => ['t', tab])
    expect(openExtensionTab({ openTrusted }, `chrome-extension://${ID}/welcome.html`)).toBeUndefined()
    expect(openTrusted).not.toHaveBeenCalled()

    gate.openWebContent()
    await vi.waitFor(() => { expect(openTrusted).toHaveBeenCalledOnce() })
    expect(isExtensionOpened(tab, ID)).toBe(true)
  })

  it('opens the new-tab page for an extension at once', async () => {
    const { openExtensionTab } = await setup()
    const openTrusted = vi.fn((): [string, WebContents] => ['t', pageWith()])
    expect(openExtensionTab({ openTrusted })?.[0]).toBe('t')
  })

  it('opens a window with pages in it once the gate opens, and one with none at once', async () => {
    const { gate, buildHostImpl, createShellWindow } = await setup()
    const win = { id: 11, isDestroyed: () => false }
    vi.mocked(createShellWindow).mockImplementation((() => win) as never)
    const host = buildHostImpl(() => ({ ctx: {}, services: {} }) as unknown as ShellBridge)

    await host.createWindow?.({} as never)
    expect(createShellWindow).toHaveBeenCalledOnce()

    const asked = host.createWindow?.({ url: 'https://example.com/' } as never)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(createShellWindow).toHaveBeenCalledOnce()

    gate.openWebContent()
    await asked
    expect(createShellWindow).toHaveBeenCalledTimes(2)
  })
})
