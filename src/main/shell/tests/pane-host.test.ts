import { describe, expect, it, vi } from 'vitest'
import { PaneHost } from '../pane-host.js'

const B = (x: number) => ({ x, y: 0, width: 100, height: 100 })

/** Electron 44's own `View`: re-adding a child already there reorders it to
 * the top instead of appending a duplicate (electron.d.ts's own doc comment
 * on `addChildView`); a fresh one goes at `index`, the end by default. */
interface FakeView { name: string, setBounds: ReturnType<typeof vi.fn>, setVisible: ReturnType<typeof vi.fn>, getVisible: () => boolean }

function setup (): { host: PaneHost, children: string[], view: (name: string) => FakeView } {
  const children: string[] = []
  const shownFlag = new Map<string, boolean>()
  const views = new Map<string, FakeView>()
  const view = (name: string): FakeView => {
    let found = views.get(name)
    if (found === undefined) {
      const made: FakeView = { name, setBounds: vi.fn(), setVisible: vi.fn((visible: boolean) => { shownFlag.set(name, visible) }), getVisible: () => shownFlag.get(name) ?? true }
      views.set(name, made)
      found = made
    }
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

  it('keeps a replaced pane at its place in the window, below a popover open above it', () => {
    const { host, children, view } = setup()
    const contentView = (host as unknown as { contentView: { addChildView: (v: never) => void } }).contentView
    contentView.addChildView(view('chrome') as never)
    host.show([{ id: 'a', view: view('A') as never, bounds: B(0) }, { id: 'b', view: view('B') as never, bounds: B(100) }], { id: 'backdrop', view: view('X') as never, bounds: B(0) })
    contentView.addChildView(view('popover') as never)

    host.replace('a', view('A2') as never, B(0))

    expect(children).toEqual(['X', 'A2', 'B', 'chrome', 'popover'])
  })
})

describe('PaneHost settling a pane whose page did not take its size', () => {
  const pane = (view: unknown, bounds = B(0)) => ({ id: 'a', view: view as never, bounds })
  const withLayout = (sizes: Array<{ width: number, height: number } | null>): { host: PaneHost, view: FakeView, reads: ReturnType<typeof vi.fn> } => {
    const { host: plain, view } = setup()
    const reads = vi.fn(async () => await Promise.resolve(sizes.shift() ?? { width: 100, height: 100 }))
    const contentView = (plain as unknown as { contentView: never }).contentView
    return { host: new PaneHost(contentView, reads), view: view('A'), reads }
  }

  it('makes the view one pixel wider and puts it back when the page lays out at another size', async () => {
    vi.useFakeTimers()
    try {
      const { host, view, reads } = withLayout([{ width: 400, height: 300 }])
      host.show([pane(view)])
      expect(reads).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(300)
      expect(reads).toHaveBeenCalledTimes(1)
      expect(view.setBounds).toHaveBeenLastCalledWith({ ...B(0), width: 101 })
      await vi.advanceTimersByTimeAsync(300)
      expect(view.setBounds).toHaveBeenLastCalledWith(B(0))
      expect(reads).toHaveBeenCalledTimes(2)
    } finally { vi.useRealTimers() }
  })

  it('leaves a pane alone whose page lays out at its size, and one it cannot read', async () => {
    vi.useFakeTimers()
    try {
      const { host, view } = withLayout([{ width: 101, height: 99 }])
      host.show([pane(view)])
      await vi.advanceTimersByTimeAsync(1000)
      expect(view.setBounds).toHaveBeenCalledTimes(1)
      const unread = withLayout([null])
      unread.host.show([pane(unread.view)])
      await vi.advanceTimersByTimeAsync(1000)
      expect(unread.view.setBounds).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })

  it('does not check a pane that was already on screen, or one taken off before the check', async () => {
    vi.useFakeTimers()
    try {
      const { host, view, reads } = withLayout([])
      host.show([pane(view)])
      await vi.advanceTimersByTimeAsync(300)
      host.show([pane(view, B(50))])
      await vi.advanceTimersByTimeAsync(1000)
      expect(reads).toHaveBeenCalledTimes(1)
      host.hide('a')
      host.show([pane(view)])
      host.hide('a')
      await vi.advanceTimersByTimeAsync(1000)
      expect(reads).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })

  it('gives up after a few tries when the page never takes the size', async () => {
    vi.useFakeTimers()
    try {
      const wrong = { width: 400, height: 300 }
      const { host, view, reads } = withLayout([wrong, wrong, wrong, wrong, wrong])
      host.show([pane(view)])
      await vi.advanceTimersByTimeAsync(5000)
      expect(reads).toHaveBeenCalledTimes(3)
    } finally { vi.useRealTimers() }
  })
  it('checks the view that replaces a pane like a pane just put on screen', async () => {
    vi.useFakeTimers()
    try {
      const { host, view, reads } = withLayout([{ width: 100, height: 100 }, { width: 400, height: 300 }])
      const { view: other } = setup()
      host.show([pane(view)])
      await vi.advanceTimersByTimeAsync(300)
      expect(reads).toHaveBeenCalledTimes(1)
      const next = other('A2')
      host.replace('a', next as never, B(5))
      await vi.advanceTimersByTimeAsync(300)
      expect(reads).toHaveBeenCalledTimes(2)
      expect(next.setBounds).toHaveBeenLastCalledWith({ ...B(5), width: 101 })
    } finally { vi.useRealTimers() }
  })

  it('checks a pane of a split again on request, and a pane that fills the area never', async () => {
    vi.useFakeTimers()
    try {
      const { host, view, reads } = withLayout([])
      const { view: other } = setup()
      host.show([pane(view)])
      await vi.advanceTimersByTimeAsync(300)
      expect(reads).toHaveBeenCalledTimes(1)
      host.recheck('a')
      await vi.advanceTimersByTimeAsync(1000)
      expect(reads).toHaveBeenCalledTimes(1)

      host.show([pane(view), { id: 'b', view: other('B') as never, bounds: B(200) }])
      await vi.advanceTimersByTimeAsync(300)
      const before = reads.mock.calls.length
      host.recheck('a')
      await vi.advanceTimersByTimeAsync(300)
      expect(reads.mock.calls.length).toBe(before + 1)
      host.recheck('gone')
    } finally { vi.useRealTimers() }
  })
})

describe('PaneHost putting a view into the window', () => {
  it('shows every view it attaches: a pane, the backdrop, and the view that replaces a pane', () => {
    const { host, view } = setup()
    host.show([{ id: 'a', view: view('A') as never, bounds: B(0) }, { id: 'b', view: view('B') as never, bounds: B(100) }], { id: 'backdrop', view: view('X') as never, bounds: B(0) })
    for (const name of ['A', 'B', 'X']) expect(view(name).setVisible).toHaveBeenLastCalledWith(true)

    host.replace('a', view('A2') as never, B(0))
    expect(view('A2').setVisible).toHaveBeenLastCalledWith(true)
  })

  it('shows a view again that was taken out of the window and comes back', () => {
    const { host, view } = setup()
    host.show([{ id: 'a', view: view('A') as never, bounds: B(0) }])
    host.show([{ id: 'b', view: view('B') as never, bounds: B(0) }])
    view('A').setVisible.mockClear()

    host.show([{ id: 'a', view: view('A') as never, bounds: B(0) }])

    expect(view('A').setVisible).toHaveBeenCalledWith(true)
  })

  it('hides and shows the pane over a pane put below it, in a later turn', () => {
    vi.useFakeTimers()
    try {
      const { host, view } = setup()
      host.show([{ id: 'b', view: view('B') as never, bounds: B(100) }])
      view('B').setVisible.mockClear()

      host.show([{ id: 'a', view: view('A') as never, bounds: B(0) }, { id: 'b', view: view('B') as never, bounds: B(100) }])
      expect(view('B').setVisible).not.toHaveBeenCalled()

      vi.advanceTimersByTime(1)
      expect(view('B').setVisible.mock.calls).toEqual([[false], [true]])
      expect(view('A').setVisible.mock.calls).toEqual([[true]])
    } finally { vi.useRealTimers() }
  })
})

describe('PaneHost mending a pane whose page is hidden', () => {
  const MEND_MS = 60
  const withReads = (reads: Record<string, boolean | null>): { host: PaneHost, view: (name: string) => FakeView, asked: ReturnType<typeof vi.fn> } => {
    const { host: plain, view } = setup()
    const asked = vi.fn(async (shown: { name: string }) => await Promise.resolve(reads[shown.name] ?? true))
    return { host: new PaneHost((plain as unknown as { contentView: never }).contentView, undefined, asked as never), view, asked }
  }
  const twoPanes = (view: (name: string) => FakeView): Array<{ id: string, view: never, bounds: ReturnType<typeof B> }> => [{ id: 'a', view: view('A') as never, bounds: B(0) }, { id: 'b', view: view('B') as never, bounds: B(100) }]

  it('hides and shows the panes beside a pane whose page reads hidden, and asks again', async () => {
    vi.useFakeTimers()
    try {
      const reads: Record<string, boolean | null> = { A: false }
      const { host, view, asked } = withReads(reads)
      host.show(twoPanes(view))
      await vi.advanceTimersByTimeAsync(1)
      view('B').setVisible.mockClear()

      await vi.advanceTimersByTimeAsync(MEND_MS)
      expect(asked).toHaveBeenCalledTimes(2)
      expect(view('B').setVisible.mock.calls).toEqual([[false], [true]])
      expect(view('A').setVisible.mock.calls.filter(([visible]) => visible === false)).toEqual([])

      reads['A'] = true
      view('B').setVisible.mockClear()
      await vi.advanceTimersByTimeAsync(MEND_MS)
      expect(asked).toHaveBeenCalledTimes(4)
      expect(view('B').setVisible).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it('leaves panes alone whose pages read visible, or cannot be read', async () => {
    vi.useFakeTimers()
    try {
      const { host, view, asked } = withReads({ A: null })
      host.show(twoPanes(view))
      await vi.advanceTimersByTimeAsync(1)
      view('A').setVisible.mockClear()
      view('B').setVisible.mockClear()
      await vi.advanceTimersByTimeAsync(MEND_MS)
      expect(asked).toHaveBeenCalledTimes(2)
      expect(view('A').setVisible).not.toHaveBeenCalled()
      expect(view('B').setVisible).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it('gives up after a few tries, and does not ask when there is one pane', async () => {
    vi.useFakeTimers()
    try {
      const { host, view, asked } = withReads({ A: false })
      host.show(twoPanes(view))
      await vi.advanceTimersByTimeAsync(2000)
      expect(asked).toHaveBeenCalledTimes(6)

      asked.mockClear()
      host.show([{ id: 'a', view: view('A') as never, bounds: B(0) }])
      await vi.advanceTimersByTimeAsync(2000)
      expect(asked).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it('asks again after a pane commits a document', async () => {
    vi.useFakeTimers()
    try {
      const { host, view, asked } = withReads({})
      host.show(twoPanes(view))
      await vi.advanceTimersByTimeAsync(2000)
      asked.mockClear()

      host.recheck('b')
      await vi.advanceTimersByTimeAsync(MEND_MS)

      expect(asked).toHaveBeenCalledTimes(2)
    } finally { vi.useRealTimers() }
  })
})
