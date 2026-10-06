import { describe, expect, it } from 'vitest'
import type { WebContents } from 'electron'
import { sidePanelTabClosing } from '../side-panel-tab-closing.js'
import type { TabClosingInfo } from '../../shell/tab-lifecycle.js'
import type { TabRecord } from '../../shell/tab-types.js'

function contents (id: number, destroyed = false): WebContents {
  return { id, isDestroyed: () => destroyed } as unknown as WebContents
}

function closing (reason: TabClosingInfo['reason'], webContents: WebContents | undefined): TabClosingInfo {
  return { id: 'tab-1', index: 0, record: { view: { webContents } } as unknown as TabRecord, reason, window: undefined }
}

function make () {
  const heard: number[] = []
  const listener = sidePanelTabClosing({ tabClosed: (id) => { heard.push(id) } })
  return { heard, listener }
}

describe('the side panel runner when a tab closes', () => {
  it('tells the driver the id of a tab that is still alive', () => {
    const { heard, listener } = make()
    listener.tabClosing(closing('closed', contents(7)))
    expect(heard).toEqual([7])
  })

  it('still tells the driver which tab closed when its page is already destroyed', () => {
    const { heard, listener } = make()
    const page = contents(7)
    listener.tabCreated(page)
    ;(page as unknown as { isDestroyed: () => boolean }).isDestroyed = () => true
    expect(() => { listener.tabClosing(closing('gone', undefined)) }).not.toThrow()
    expect(heard).toEqual([7])
  })

  it('leaves the tabs that are still alive alone when a destroyed page is forgotten', () => {
    const { heard, listener } = make()
    listener.tabCreated(contents(7))
    listener.tabCreated(contents(8, true))
    listener.tabClosing(closing('gone', undefined))
    expect(heard).toEqual([8])
  })

  it('does not tell the driver about a tab handed to another window', () => {
    const { heard, listener } = make()
    listener.tabClosing(closing('moved', contents(7)))
    expect(heard).toEqual([])
  })

  it('forgets a page whose view was replaced', () => {
    const { heard, listener } = make()
    const old = contents(7, true)
    listener.tabCreated(old)
    listener.viewReplaced(old, contents(9))
    listener.tabClosing(closing('gone', undefined))
    expect(heard).toEqual([])
  })
})
