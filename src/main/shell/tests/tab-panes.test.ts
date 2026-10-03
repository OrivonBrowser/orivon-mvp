import { describe, expect, it, vi } from 'vitest'
import { TabPanes } from '../tab-panes.js'

const AREA = { x: 0, y: 40, width: 800, height: 560 }

function setup (shell?: unknown): {
  panes: InstanceType<typeof TabPanes>
  tab: (id: string) => void
  activate: (id: string) => void
  pageGone: (id: string) => void
} {
  const children: string[] = ['chrome']
  const views = new Map<string, { name: string, webContents: { isDestroyed: () => boolean } | undefined, setBounds: ReturnType<typeof vi.fn>, setVisible: ReturnType<typeof vi.fn> }>()
  const records = new Map<string, { view: unknown }>()
  let active: string | null = null
  const contentView = {
    get children () { return children.map((name) => views.get(name) ?? { name }) },
    addChildView: vi.fn((child: { name: string }, index?: number) => {
      const at = children.indexOf(child.name)
      if (at !== -1) children.splice(at, 1)
      if (at !== -1 || index === undefined) children.push(child.name)
      else children.splice(Math.min(index, children.length), 0, child.name)
    }),
    removeChildView: vi.fn((child: { name: string }) => { const at = children.indexOf(child.name); if (at !== -1) children.splice(at, 1) })
  }
  const panes = new TabPanes({
    contentView: contentView as never,
    splits: { plan: (id: string | null) => ({ panes: id === null ? [] : [{ id, bounds: AREA }], frame: null }), groups: { partnerOf: () => null } } as never,
    record: (id: string) => records.get(id) as never,
    records: () => records.entries() as never,
    activeId: () => active,
    setActiveId: (id: string) => { active = id },
    area: () => AREA,
    isClosing: () => false,
    emitState: () => {},
    shell: shell as never
  })
  return {
    panes,
    tab: (id) => {
      const view = { name: id, webContents: { isDestroyed: () => false }, setBounds: vi.fn(), setVisible: vi.fn() }
      views.set(id, view)
      records.set(id, { view })
    },
    activate: (id) => { active = id; panes.sync() },
    // What Electron leaves on a view whose page has closed: no webContents at all.
    pageGone: (id) => { const view = views.get(id); if (view !== undefined) view.webContents = undefined }
  }
}

describe('TabPanes: telling the lifecycle which tabs are on screen', () => {
  it('skips a tab whose page has already closed, rather than throwing out of the hide that closes it', () => {
    const shownChanged = vi.fn()
    const { panes, tab, activate, pageGone } = setup({ tabLifecycle: { shownChanged }, window: {} })
    tab('kept')
    tab('closing')
    activate('closing')
    pageGone('closing')
    expect(() => { panes.hide('closing') }).not.toThrow()
    const [, tabs] = shownChanged.mock.calls.at(-1) ?? []
    expect((tabs as Array<{ shown: boolean }>).map((entry) => entry.shown)).toEqual([false])
  })
})
