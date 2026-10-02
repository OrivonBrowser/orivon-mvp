import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { ShellBridge } from '../extension-host-impl.js'

const ID = 'abcdefghijklmnopabcdefghijklmnop'

vi.mock('electron', () => ({ session: { defaultSession: { extensions: { getExtension: vi.fn((id: string) => id === 'abcdefghijklmnopabcdefghijklmnop' ? {} : null) } } } }))
vi.mock('../../shell/window.js', () => ({ createShellWindow: vi.fn() }))

const { buildHostImpl } = await import('../extension-host-impl.js')
const { isExtensionOpened } = await import('../extension-opened-pages.js')

function bridgeWith (record: Record<string, unknown>): ShellBridge {
  const tabs = { faviconFor: () => null, record: () => record }
  return { services: { windows: { findTab: () => ({ window: { tabs }, tabId: 't1' }) } } } as unknown as ShellBridge
}

describe('buildHostImpl: assignTabDetails', () => {
  it('reports a sleeping tab as discarded, with the address and title it will wake to', () => {
    const host = buildHostImpl(() => bridgeWith({ pinned: false, sleeping: { url: 'https://a.example/', title: 'A', favicon: null } }))
    const details = { pinned: false, url: 'about:blank', title: '' }
    host.assignTabDetails?.(details as never, {} as WebContents)
    expect(details).toMatchObject({ discarded: true, url: 'https://a.example/', title: 'A' })
  })

  it('leaves an awake tab as the library built it', () => {
    const host = buildHostImpl(() => bridgeWith({ pinned: true }))
    const details: Record<string, unknown> = { pinned: false, url: 'https://b.example/', title: 'B' }
    host.assignTabDetails?.(details as never, {} as WebContents)
    expect(details).toEqual({ pinned: true, url: 'https://b.example/', title: 'B' })
  })
})

describe('buildHostImpl: pages the extension opens count as its own', () => {
  const pageWith = (): WebContents => ({ on: vi.fn(), loadURL: vi.fn(async () => undefined) }) as unknown as WebContents

  it('marks a tab chrome.tabs.create opens on an extension page, and not one it opens on the web', async () => {
    const extensionTab = pageWith()
    const webTab = pageWith()
    const openTrusted = vi.fn((target?: string): [string, WebContents] => ['t', target?.startsWith('https:') === true ? webTab : extensionTab])
    const win = { id: 1 }
    const bridge = { services: { windows: { focused: () => ({ window: win }), all: () => [{ window: win, tabs: { openTrusted } }] } } } as unknown as ShellBridge
    const host = buildHostImpl(() => bridge)

    await host.createTab?.({ url: `chrome-extension://${ID}/welcome.html` } as never)
    await host.createTab?.({ url: 'https://example.com/' } as never)

    expect(isExtensionOpened(extensionTab, ID)).toBe(true)
    expect(webTab.on).not.toHaveBeenCalled()
  })

  it('marks a tab chrome.tabs.update sends to an extension page', async () => {
    const tab = pageWith()
    const host = buildHostImpl(() => undefined)

    await host.navigateTab?.(tab, `chrome-extension://${ID}/options.html`)

    expect(isExtensionOpened(tab, ID)).toBe(true)
    expect(tab.loadURL).toHaveBeenCalledWith(`chrome-extension://${ID}/options.html`)
  })
})
