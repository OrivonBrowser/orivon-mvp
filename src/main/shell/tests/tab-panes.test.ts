import { beforeEach, describe, expect, it, vi } from 'vitest'

let painted: Array<() => void> = []
vi.mock('../first-paint.js', () => ({
  whenPainted: vi.fn(() => new Promise<void>((resolve) => { painted.push(resolve) }))
}))

const { TabPanes } = await import('../tab-panes.js')

const AREA = { x: 0, y: 40, width: 800, height: 560 }

function setup (shell?: unknown): {
  panes: InstanceType<typeof TabPanes>
  children: string[]
  tab: (id: string, isDashboardTab: boolean) => void
  activate: (id: string) => void
  pageGone: (id: string) => void
} {
  const children: string[] = ['chrome']
  const views = new Map<string, { name: string, webContents: { isDestroyed: () => boolean } | undefined, setBounds: ReturnType<typeof vi.fn> }>()
  const records = new Map<string, { view: unknown, isDashboardTab: boolean }>()
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
    children,
    tab: (id, isDashboardTab) => {
      const view = { name: id, webContents: { isDestroyed: () => false }, setBounds: vi.fn() }
      views.set(id, view)
      records.set(id, { view, isDashboardTab })
    },
    activate: (id) => { active = id; panes.sync() },
    // What Electron leaves on a view whose page has closed: no webContents at all.
    pageGone: (id) => { const view = views.get(id); if (view !== undefined) view.webContents = undefined }
  }
}

beforeEach(() => { painted = [] })

describe('TabPanes: a new-tab page coming to the screen', () => {
  it('keeps the page that was in front attached, with the new view under it, until the new page has painted', () => {
    const { children, tab, activate } = setup()
    tab('web', false)
    tab('dash', true)
    activate('web')
    activate('dash')
    expect(children).toEqual(['chrome', 'dash', 'web'])
    expect(painted).toHaveLength(1)

    painted[0]?.()
    return Promise.resolve().then(() => { expect(children).toEqual(['chrome', 'dash']) })
  })

  it('does not wait for the first tab of a window, which has nothing in front of it', () => {
    const { children, tab, activate } = setup()
    tab('dash', true)
    activate('dash')
    expect(children).toEqual(['chrome', 'dash'])
    expect(painted).toHaveLength(0)
  })

  it('does not wait for a website tab', () => {
    const { children, tab, activate } = setup()
    tab('a', false)
    tab('b', false)
    activate('a')
    activate('b')
    expect(children).toEqual(['chrome', 'b'])
    expect(painted).toHaveLength(0)
  })

  it('lets go of the page in front as soon as another tab is chosen, and never waits on the same page twice', async () => {
    const { children, tab, activate } = setup()
    tab('web', false)
    tab('other', false)
    tab('dash', true)
    activate('web')
    activate('dash')
    activate('other')
    expect(children).toEqual(['chrome', 'other'])

    activate('dash')
    expect(children).toEqual(['chrome', 'dash'])
    expect(painted).toHaveLength(1)
  })
})

describe('TabPanes: telling the lifecycle which tabs are on screen', () => {
  it('skips a tab whose page has already closed, rather than throwing out of the hide that closes it', () => {
    const shownChanged = vi.fn()
    const { panes, tab, activate, pageGone } = setup({ tabLifecycle: { shownChanged }, window: {} })
    tab('kept', false)
    tab('closing', false)
    activate('closing')
    pageGone('closing')
    expect(() => { panes.hide('closing') }).not.toThrow()
    const [, tabs] = shownChanged.mock.calls.at(-1) ?? []
    expect((tabs as Array<{ shown: boolean }>).map((entry) => entry.shown)).toEqual([false])
  })
})
