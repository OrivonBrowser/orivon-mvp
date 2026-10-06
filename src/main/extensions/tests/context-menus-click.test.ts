import { describe, expect, it, vi } from 'vitest'

// UPSTREAM.md patch 70: a click on one of an extension's context-menu items tells the host before the extension hears of it.
vi.mock('electron', () => ({ Menu: class {}, MenuItem: class {}, nativeImage: {} }))

const { ContextMenusAPI } = await import('../../../../vendor/electron-chrome-extensions/src/browser/api/context-menus.js')

const ID = 'd'.repeat(32)

function setup (withHook: boolean) {
  const order: string[] = []
  const tab = { id: 3, isDestroyed: () => false }
  const ctx = {
    router: { apiHandler: () => vi.fn(), sendEvent: (_id: string, name: string) => { order.push(`event:${name}`) } },
    session: { extensions: { on: vi.fn() } },
    store: {
      impl: withHook ? { menuItemClicked: (id: string, contents: unknown) => { order.push(`hook:${id}:${String(contents === tab)}`) } } : {},
      tabDetailsCache: new Map([[3, { id: 3 }]])
    }
  }
  const api = new ContextMenusAPI(ctx as never)
  return { order, click: () => { (api as any).onClicked(ID, 'item', tab, { pageURL: 'https://a.example/' }) } }
}

describe('a context-menu click', () => {
  it('calls menuItemClicked, with the tab, before onClicked is sent', () => {
    const s = setup(true)
    s.click()
    expect(s.order).toEqual([`hook:${ID}:true`, 'event:contextMenus.onClicked'])
  })

  it('still sends onClicked when the host has no such hook', () => {
    const s = setup(false)
    s.click()
    expect(s.order).toEqual(['event:contextMenus.onClicked'])
  })
})
