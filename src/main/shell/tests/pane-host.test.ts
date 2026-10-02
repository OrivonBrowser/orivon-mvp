import { describe, expect, it, vi } from 'vitest'
import { PaneHost } from '../pane-host.js'

const B = (x: number) => ({ x, y: 0, width: 100, height: 100 })

/** Electron 44's own `View`: re-adding a child already there reorders it to
 * the top instead of appending a duplicate (electron.d.ts's own doc comment
 * on `addChildView`); a fresh one goes at `index`, the end by default. */
function setup (): { host: PaneHost, children: string[], view: (name: string) => { name: string, setBounds: ReturnType<typeof vi.fn> } } {
  const children: string[] = []
  const views = new Map<string, { name: string, setBounds: ReturnType<typeof vi.fn> }>()
  const view = (name: string): { name: string, setBounds: ReturnType<typeof vi.fn> } => {
    let found = views.get(name)
    if (found === undefined) { found = { name, setBounds: vi.fn() }; views.set(name, found) }
    return found
  }
  const contentView = {
    get children () { return children.map(view) },
    addChildView: vi.fn((child: { name: string }, index?: number) => {
      const at = children.indexOf(child.name)
      if (at !== -1) children.splice(at, 1)
      if (at !== -1 || index === undefined) children.push(child.name)
      else children.splice(Math.min(index, children.length), 0, child.name)
    }),
    removeChildView: vi.fn((child: { name: string }) => { const at = children.indexOf(child.name); if (at !== -1) children.splice(at, 1) })
  }
  return { host: new PaneHost(contentView as never), children, view }
}

describe('PaneHost', () => {
  it('shows a pane at its bounds, and swaps it for another', () => {
    const { host, children, view } = setup()
    host.show([{ id: 'a', view: view('A') as never, bounds: B(0) }])
    expect(children).toEqual(['A'])
    expect(view('A').setBounds).toHaveBeenLastCalledWith(B(0))

    host.show([{ id: 'b', view: view('B') as never, bounds: B(0) }])
    expect(children).toEqual(['B'])
    expect(host.isShown('a')).toBe(false)
    expect(host.isShown('b')).toBe(true)
  })

  it('sizes a pane that stays without taking it off the screen', () => {
    const { host, children, view } = setup()
    host.show([{ id: 'a', view: view('A') as never, bounds: B(0) }])
    host.show([{ id: 'a', view: view('A') as never, bounds: B(50) }])
    expect(children).toEqual(['A'])
    expect(view('A').setBounds).toHaveBeenLastCalledWith(B(50))
  })

  it('puts a backdrop under the panes, whether they were on screen first or not', () => {
    const { host, children, view } = setup()
    host.show([{ id: 'a', view: view('A') as never, bounds: B(0) }])
    host.show([{ id: 'a', view: view('A') as never, bounds: B(0) }, { id: 'b', view: view('B') as never, bounds: B(100) }], { id: 'backdrop', view: view('X') as never, bounds: B(0) })
    expect(children).toEqual(['X', 'A', 'B'])
  })

  it('never takes a pane that is staying off the screen when a backdrop first appears beside it', () => {
    const { host, children, view } = setup()
    const contentView = (host as unknown as { contentView: { removeChildView: ReturnType<typeof vi.fn> } }).contentView
    host.show([{ id: 'a', view: view('A') as never, bounds: B(0) }])
    contentView.removeChildView.mockClear()

    host.show([{ id: 'a', view: view('A') as never, bounds: B(0) }, { id: 'b', view: view('B') as never, bounds: B(100) }], { id: 'backdrop', view: view('X') as never, bounds: B(0) })

    // The pane already on screen (A) is never detached for a backdrop that
    // has nothing to do with it -- only B, genuinely new here, is a fresh attach.
    expect(contentView.removeChildView).not.toHaveBeenCalled()
    expect(children).toEqual(['X', 'A', 'B'])
  })

  it('leaves the backdrop and the panes alone when only their sizes change, and adds a third pane above it', () => {
    const { host, children, view } = setup()
    const backdrop = { id: 'backdrop', view: view('X') as never, bounds: B(0) }
    host.show([{ id: 'a', view: view('A') as never, bounds: B(0) }], backdrop)
    host.show([{ id: 'a', view: view('A') as never, bounds: B(10) }, { id: 'b', view: view('B') as never, bounds: B(100) }], backdrop)
    expect(children).toEqual(['X', 'A', 'B'])
  })

  it('takes the backdrop away when there is none, and keeps the panes', () => {
    const { host, children, view } = setup()
    const backdrop = { id: 'backdrop', view: view('X') as never, bounds: B(0) }
    host.show([{ id: 'a', view: view('A') as never, bounds: B(0) }, { id: 'b', view: view('B') as never, bounds: B(100) }], backdrop)
    host.show([{ id: 'b', view: view('B') as never, bounds: B(0) }])
    expect(children).toEqual(['B'])
  })

  it('hides a pane, once, and none that is not there', () => {
    const { host, children, view } = setup()
    host.show([{ id: 'a', view: view('A') as never, bounds: B(0) }])
    host.hide('a')
    host.hide('a')
    host.hide('nothing')
    expect(children).toEqual([])
    expect(host.isShown('a')).toBe(false)
  })

  it('touches neither addChildView nor removeChildView for panes a resize re-shows unchanged', () => {
    // window.ts's layoutAll calls tabs.layout() -> syncViews() -> this show() on every window
    // resize, with the very same panes and backdrop as before: none of them may be re-added, or a
    // resize would raise every pane above the welcome screen, the fullscreen notice and any open
    // popover that shares this same contentView.
    const { host, children, view } = setup()
    const backdrop = { id: 'backdrop', view: view('X') as never, bounds: B(0) }
    const panes = [{ id: 'a', view: view('A') as never, bounds: B(0) }, { id: 'b', view: view('B') as never, bounds: B(100) }]
    host.show(panes, backdrop)
    const contentView = (host as unknown as { contentView: { addChildView: ReturnType<typeof vi.fn>, removeChildView: ReturnType<typeof vi.fn> } }).contentView
    contentView.addChildView.mockClear()
    contentView.removeChildView.mockClear()

    host.show(panes, backdrop)

    expect(contentView.addChildView).not.toHaveBeenCalled()
    expect(contentView.removeChildView).not.toHaveBeenCalled()
    expect(children).toEqual(['X', 'A', 'B'])
    expect(view('A').setBounds).toHaveBeenLastCalledWith(B(0))
    expect(view('B').setBounds).toHaveBeenLastCalledWith(B(100))
  })

  it('puts a pane dropped to the right straight after its partner, below whatever the window appended since', () => {
    const { host, children, view } = setup()
    const contentView = (host as unknown as { contentView: { addChildView: (v: never) => void } }).contentView
    contentView.addChildView(view('chrome') as never)
    const backdrop = { id: 'backdrop', view: view('X') as never, bounds: B(0) }
    host.show([{ id: 'a', view: view('A') as never, bounds: B(0) }])
    contentView.addChildView(view('popover') as never)

    host.show([{ id: 'a', view: view('A') as never, bounds: B(0) }, { id: 'b', view: view('B') as never, bounds: B(100) }], backdrop)

    expect(children).toEqual(['X', 'chrome', 'A', 'B', 'popover'])
  })

  it('puts a pane dropped to the left straight before its partner', () => {
    const { host, children, view } = setup()
    const contentView = (host as unknown as { contentView: { addChildView: (v: never) => void } }).contentView
    contentView.addChildView(view('chrome') as never)
    const backdrop = { id: 'backdrop', view: view('X') as never, bounds: B(0) }
    host.show([{ id: 'a', view: view('A') as never, bounds: B(0) }])
    contentView.addChildView(view('popover') as never)

    host.show([{ id: 'b', view: view('B') as never, bounds: B(0) }, { id: 'a', view: view('A') as never, bounds: B(100) }], backdrop)

    expect(children).toEqual(['X', 'chrome', 'B', 'A', 'popover'])
  })

  it('stacks two panes that are both new right after the backdrop, in the order given', () => {
    const { host, children, view } = setup()
    const contentView = (host as unknown as { contentView: { addChildView: (v: never) => void } }).contentView
    contentView.addChildView(view('chrome') as never)
    contentView.addChildView(view('popover') as never)

    host.show([{ id: 'a', view: view('A') as never, bounds: B(0) }, { id: 'b', view: view('B') as never, bounds: B(100) }], { id: 'backdrop', view: view('X') as never, bounds: B(0) })

    expect(children).toEqual(['X', 'A', 'B', 'chrome', 'popover'])
  })

  it('shows a different view in a pane\'s place', () => {
    const { host, children, view } = setup()
    host.show([{ id: 'a', view: view('A') as never, bounds: B(0) }])
    host.replace('a', view('A2') as never, B(5))
    expect(children).toEqual(['A2'])
    expect(host.isShown('a')).toBe(true)
    expect(view('A2').setBounds).toHaveBeenLastCalledWith(B(5))
  })
})
