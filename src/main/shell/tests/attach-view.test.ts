import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ View: class FakeMarker { readonly marker = true } }))

const { attachShown, showAgain } = await import('../attach-view.js')

interface FakeView { name: string, visible: boolean, setVisible: ReturnType<typeof vi.fn>, getVisible: () => boolean }

function setup (): { parent: { children: unknown[], addChildView: (child: unknown, index?: number) => void, removeChildView: (child: unknown) => void }, view: (name: string, visible?: boolean) => FakeView, log: string[] } {
  const log: string[] = []
  const children: unknown[] = []
  const name = (child: unknown): string => (child as { name?: string }).name ?? 'marker'
  const parent = {
    get children () { return [...children] },
    addChildView: vi.fn((child: unknown, index?: number) => {
      log.push(`add ${name(child)}${index === undefined ? '' : `@${String(index)}`}`)
      const at = children.indexOf(child)
      if (at !== -1) children.splice(at, 1)
      if (index === undefined || at !== -1) children.push(child)
      else children.splice(index, 0, child)
    }),
    removeChildView: vi.fn((child: unknown) => {
      log.push(`remove ${name(child)}`)
      const at = children.indexOf(child)
      if (at !== -1) children.splice(at, 1)
    })
  }
  const view = (viewName: string, visible = true): FakeView => {
    const made: FakeView = {
      name: viewName,
      visible,
      setVisible: vi.fn((next: boolean) => { made.visible = next; log.push(`${viewName}.setVisible(${String(next)})`) }),
      getVisible: () => made.visible
    }
    return made
  }
  return { parent, view, log }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('attachShown', () => {
  it('adds the view, makes it visible and lets the window complete the attach with a child that comes and goes', () => {
    const { parent, view, log } = setup()
    const page = view('page')

    attachShown(parent as never, page as never)

    expect(log).toEqual(['add page', 'page.setVisible(true)', 'add marker', 'remove marker'])
    expect(parent.children).toEqual([page])
  })

  it('adds the view at an index when given one', () => {
    const { parent, view, log } = setup()
    attachShown(parent as never, view('below') as never, 0)
    expect(log[0]).toBe('add below@0')
  })

  it('makes visible a view that was hidden in place', () => {
    const { parent, view } = setup()
    const page = view('page', false)
    attachShown(parent as never, page as never)
    expect(page.visible).toBe(true)
  })

  it('hides and shows each page that is over it in a later turn than the attach, and none that is hidden or gone', () => {
    const { parent, view, log } = setup()
    const over = view('over')
    const hidden = view('hidden', false)
    const gone = view('gone')
    attachShown(parent as never, over as never)
    attachShown(parent as never, hidden as never)
    hidden.visible = false
    log.length = 0

    attachShown(parent as never, view('page') as never, 0, [over, hidden, gone] as never)
    expect(log).not.toContain('over.setVisible(false)')

    vi.advanceTimersByTime(1)
    expect(log.filter((entry) => entry.startsWith('over.'))).toEqual(['over.setVisible(false)', 'over.setVisible(true)'])
    expect(log.some((entry) => entry.startsWith('hidden.'))).toBe(false)
    expect(log.some((entry) => entry.startsWith('gone.'))).toBe(false)
  })

  it('does nothing in the later turn when the view has left the window by then', () => {
    const { parent, view, log } = setup()
    const over = view('over')
    attachShown(parent as never, over as never)
    const page = view('page')
    attachShown(parent as never, page as never, 0, [over] as never)
    parent.removeChildView(page)
    log.length = 0

    vi.advanceTimersByTime(1)

    expect(log).toEqual([])
  })
})

describe('showAgain', () => {
  it('does not throw when the window is gone', () => {
    const { view } = setup()
    const parent = { get children (): unknown[] { throw new Error('Object has been destroyed') } }
    expect(() => { showAgain(parent as never, view('page') as never, []) }).not.toThrow()
  })
})
