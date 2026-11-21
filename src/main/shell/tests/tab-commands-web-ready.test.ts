import { describe, expect, it, vi } from 'vitest'
import type { TabManager } from '../tabs.js'

/** A fresh gate and the tab commands over it: the gate's state lasts as long as its module. */
async function setup (url = 'https://a.example/') {
  vi.resetModules()
  const gate = await import('../../startup/web-ready.js')
  const commands = await import('../tab-commands.js')
  const created = { id: 'copy', groupId: undefined as string | null | undefined }
  const tabs = {
    hasRoom: () => true,
    getState: () => ({ tabs: [{ id: 'a', pinned: false, isNewTab: false, isInternal: false, url }, { id: 'b', pinned: false, isNewTab: true, isInternal: false, url: '' }] }),
    createTab: vi.fn(() => 'copy'),
    record: vi.fn((id: string) => id === 'copy' ? created : { groupId: null, tunnelChoice: undefined, sleeping: null, host: {} }),
    moveTab: vi.fn(),
    liveWebContents: vi.fn(() => undefined)
  }
  return { gate, ...commands, tabs, manager: tabs as unknown as TabManager }
}

describe('tab commands before web pages may load', () => {
  it('opens an address beside a tab once the gate opens, and answers no id meanwhile: createTab would answer the tab in front', async () => {
    const { gate, openBeside, tabs, manager } = await setup()
    expect(openBeside(manager, 'a', 'https://b.example/')).toBeUndefined()
    expect(tabs.createTab).not.toHaveBeenCalled()

    gate.openWebContent()
    await vi.waitFor(() => { expect(tabs.createTab).toHaveBeenCalledOnce() })
    expect(tabs.createTab).toHaveBeenCalledWith('https://b.example/', true, undefined, undefined)
    expect(tabs.moveTab).toHaveBeenCalledOnce()
  })

  it('opens the new-tab page beside a tab at once: it loads nothing from the web', async () => {
    const { newTabToRight, tabs, manager } = await setup()
    newTabToRight(manager, 'a')
    expect(tabs.createTab).toHaveBeenCalledWith(undefined, true, undefined, undefined)
    expect(tabs.moveTab).toHaveBeenCalledOnce()
  })

  it('copies a tab whole once the gate opens, so the copy is the new tab and gets the history', async () => {
    const { gate, duplicateTab, tabs, manager } = await setup()
    duplicateTab(manager, 'a')
    expect(tabs.createTab).not.toHaveBeenCalled()

    gate.openWebContent()
    await vi.waitFor(() => { expect(tabs.createTab).toHaveBeenCalledOnce() })
    expect(tabs.createTab).toHaveBeenCalledWith('https://a.example/', true, undefined, undefined)
    expect(tabs.liveWebContents).toHaveBeenCalledWith('copy')
  })

  it('does not wait to refuse a copy of the new-tab page, and copies nothing once the gate opens', async () => {
    const { gate, duplicateTab, tabs, manager } = await setup()
    duplicateTab(manager, 'b')
    gate.openWebContent()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(tabs.createTab).not.toHaveBeenCalled()
  })

  it('opens a copy at once when the gate is open', async () => {
    const { gate, duplicateTab, tabs, manager } = await setup()
    gate.openWebContent()
    await gate.webContentReady()
    duplicateTab(manager, 'a')
    expect(tabs.createTab).toHaveBeenCalledOnce()
  })
})
