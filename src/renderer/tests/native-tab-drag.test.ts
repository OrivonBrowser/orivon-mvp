import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeDragHost, NativeDragShell } from '../native-tab-drag.js'
import { placerFor } from '../tab-drag.js'

const TYPE = 'application/x-test-tab'

type Listener = (event: Record<string, unknown>) => void

class Listeners {
  private readonly map = new Map<string, Listener[]>()
  addEventListener (type: string, listener: Listener): void { this.map.set(type, [...(this.map.get(type) ?? []), listener]) }
  fire (type: string, event: Record<string, unknown> = {}): void { for (const listener of this.map.get(type) ?? []) listener({ type, preventDefault: vi.fn(), ...event }) }
}

class FakeTab extends Listeners {
  draggable = false
  readonly classes = new Set<string>()
  readonly classList = {
    add: (name: string): void => { this.classes.add(name) },
    remove: (name: string): void => { this.classes.delete(name) }
  }

  readonly dataset: Record<string, string>
  constructor (id: string, readonly left: number, readonly width = 100) { super(); this.dataset = { id } }
  getBoundingClientRect (): { left: number, right: number, top: number, width: number } { return { left: this.left, right: this.left + this.width, top: 0, width: this.width } }
  cloneNode (): FakeChip { return new FakeChip() }
}

class FakeChip {
  readonly style: Record<string, string> = {}
  readonly classList = { add: vi.fn() }
  removed = false
  removeAttribute (): void {}
  setAttribute (): void {}
  remove (): void { this.removed = true }
}

class FakeImage extends FakeChip {
  src = ''
  async decode (): Promise<void> {}
}

function transfer (types: string[] = [], data = '') {
  return {
    types,
    effectAllowed: '',
    dropEffect: '',
    data: new Map<string, string>(),
    clearData: vi.fn(),
    setData (type: string, value: string) { this.data.set(type, value) },
    getData: () => data,
    setDragImage: vi.fn()
  }
}

async function setup (options: { thumbnail?: string | null, pinned?: boolean } = {}) {
  vi.resetModules()
  const document = Object.assign(new Listeners(), { body: { append: vi.fn() } })
  const window = new Listeners()
  const frames: Array<() => void> = []
  vi.stubGlobal('document', document)
  vi.stubGlobal('window', window)
  vi.stubGlobal('Image', FakeImage)
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => { frames.push(fn) })
  const tabs = [new FakeTab('a', 0), new FakeTab('b', 100), new FakeTab('c', 200)]
  const shell: NativeDragShell = {
    prepareTabDrag: vi.fn(async () => options.thumbnail ?? null),
    warmDropCatchers: vi.fn(),
    startNativeTabDrag: vi.fn(),
    dropNativeTab: vi.fn(),
    endNativeTabDrag: vi.fn(),
    cancelNativeTabDrag: vi.fn()
  }
  const marks: Array<[number | null, readonly string[]]> = []
  const host: NativeDragHost = {
    tabs: () => tabs as unknown as HTMLElement[],
    isPinned: () => options.pinned === true,
    partnerOf: () => null,
    stateIndex: (held, target) => held.length === 0 ? target : target + 100,
    showMark: (index, held) => { marks.push([index, held]) },
    stripBottom: () => 36,
    toolbarBottom: () => 76,
    finished: vi.fn()
  }
  const { createNativeTabDrag } = await import('../native-tab-drag.js')
  const { isDraggingTab } = await import('../tab-drag.js')
  const drag = createNativeTabDrag(TYPE, shell, host)
  for (const tab of tabs) drag.attach(tab as unknown as HTMLElement, tab.dataset['id'] ?? '')
  const pointer = (x: number, y = 10, extra: Record<string, unknown> = {}) => ({ button: 0, buttons: 1, target: { closest: () => null }, clientX: x, clientY: y, ...extra })
  /** A press on tab `n` and the drag the browser starts from it. */
  async function begin (n: number, dt = transfer()) {
    const tab = tabs[n] as FakeTab
    tab.fire('pointerdown', pointer(tab.left + 40))
    await Promise.resolve()
    await Promise.resolve()
    tab.fire('dragstart', { dataTransfer: dt, clientX: tab.left + 40, clientY: 12 })
    return { tab, dt }
  }
  return { tabs, shell, host, marks, window, document, frames, drag, pointer, begin, isDraggingTab }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('placerFor', () => {
  const strip = [new FakeTab('a', 0), new FakeTab('b', 100), new FakeTab('c', 200)] as unknown as HTMLElement[]

  it('places a held tab among the others by their centres', () => {
    const placer = placerFor(strip, [strip[0] as HTMLElement], false)
    expect(placer.others).toHaveLength(2)
    expect(placer.firstAt).toBe(0)
    expect([10, 140, 160, 400].map(placer.placeAt)).toEqual([0, 0, 1, 2])
  })

  it('places a tab arriving from elsewhere among all of them, within its own run', () => {
    const placer = placerFor(strip, [], false, (el) => el === strip[0])
    expect(placer.firstAt).toBe(3)
    expect([10, 140, 400].map(placer.placeAt)).toEqual([1, 1, 3])
    expect([10, 400].map(placerFor(strip, [], true, (el) => el === strip[0]).placeAt)).toEqual([0, 1])
  })
})

describe('a tab pulled with the browser\'s own drag and drop', () => {
  it('makes tabs draggable and asks for the page thumbnail on a press, for the catchers only once the press is pulled', async () => {
    const { tabs, shell, pointer } = await setup()
    const tab = tabs[1] as FakeTab
    expect(tabs.every((el) => el.draggable)).toBe(true)

    tab.fire('pointerdown', pointer(140))
    expect(shell.prepareTabDrag).toHaveBeenCalledWith('b')
    tab.fire('pointermove', pointer(141))
    expect(shell.warmDropCatchers).not.toHaveBeenCalled()
    tab.fire('pointermove', pointer(144))
    tab.fire('pointermove', pointer(150))
    expect(shell.warmDropCatchers).toHaveBeenCalledTimes(1)
  })

  it('prepares nothing for a press on the close button or with another button', async () => {
    const { tabs, shell, pointer } = await setup()
    ;(tabs[0] as FakeTab).fire('pointerdown', pointer(40, 10, { target: { closest: () => ({}) } }))
    ;(tabs[0] as FakeTab).fire('pointerdown', pointer(40, 10, { button: 2 }))
    expect(shell.prepareTabDrag).not.toHaveBeenCalled()
  })

  it('carries only a nonce, hides the tab a frame after the drag begins, and holds the strip', async () => {
    const { shell, begin, frames, isDraggingTab } = await setup()
    const { tab, dt } = await begin(1)

    expect(dt.clearData).toHaveBeenCalled()
    expect([...dt.data.keys()]).toEqual([TYPE])
    const nonce = dt.data.get(TYPE) ?? ''
    expect(nonce).toMatch(/^[0-9a-f-]{36}$/)
    expect(dt.effectAllowed).toBe('move')
    expect(shell.startNativeTabDrag).toHaveBeenCalledWith('b', nonce)
    expect(isDraggingTab()).toBe(true)
    expect(tab.classes.has('drag-source')).toBe(false)
    frames.forEach((frame) => { frame() })
    expect(tab.classes.has('drag-source')).toBe(true)
  })

  it('draws the tab as the drag image, trailing the pointer, until the page thumbnail has come', async () => {
    const { begin } = await setup({ thumbnail: null })
    const { dt } = await begin(1)
    expect(dt.setDragImage).toHaveBeenCalledWith(expect.any(FakeChip), -16, -16)
  })

  it('draws the page thumbnail once it has come', async () => {
    const { tabs, pointer } = await setup({ thumbnail: 'data:image/png;base64,AA==' })
    const tab = tabs[0] as FakeTab
    tab.fire('pointerdown', pointer(40))
    for (let turn = 0; turn < 6; turn += 1) await Promise.resolve()
    const dt = transfer()
    tab.fire('dragstart', { dataTransfer: dt, clientX: 40, clientY: 12 })
    expect(dt.setDragImage).toHaveBeenCalledWith(expect.any(FakeImage), -16, -16)
  })

  it('refuses a drag that did not start from a press on the tab', async () => {
    const { tabs, shell } = await setup()
    const dt = transfer()
    const preventDefault = vi.fn()
    ;(tabs[0] as FakeTab).fire('dragstart', { dataTransfer: dt, preventDefault })
    expect(preventDefault).toHaveBeenCalled()
    expect(shell.startNativeTabDrag).not.toHaveBeenCalled()
  })

  it('discards what a click prepared', async () => {
    const { tabs, pointer, window } = await setup()
    const tab = tabs[0] as FakeTab
    tab.fire('pointerdown', pointer(40))
    window.fire('pointerup')
    const dt = transfer()
    const preventDefault = vi.fn()
    tab.fire('dragstart', { dataTransfer: dt, preventDefault })
    expect(preventDefault).toHaveBeenCalled()
  })

  it('tells main the drag ended, lets the strip redraw, and reports an Escape that follows', async () => {
    const { shell, host, begin, window, isDraggingTab, marks } = await setup()
    const { tab, dt } = await begin(2)
    const nonce = dt.data.get(TYPE) ?? ''

    tab.fire('dragend')
    expect(shell.endNativeTabDrag).toHaveBeenCalledWith(nonce)
    expect(host.finished).toHaveBeenCalledTimes(1)
    expect(isDraggingTab()).toBe(false)
    expect(marks.at(-1)).toEqual([null, []])

    window.fire('keyup', { key: 'a' })
    expect(shell.cancelNativeTabDrag).not.toHaveBeenCalled()
    window.fire('keyup', { key: 'Escape' })
    window.fire('keyup', { key: 'Escape' })
    expect(shell.cancelNativeTabDrag).toHaveBeenCalledExactlyOnceWith(nonce)
  })

  it('ends a drag the browser dropped without a dragend, at the first pointer event that reaches the page again', async () => {
    const { shell, host, begin, window, isDraggingTab } = await setup()
    const { tab, dt } = await begin(1)
    const nonce = dt.data.get(TYPE) ?? ''
    window.fire('pointercancel')
    expect(shell.endNativeTabDrag).not.toHaveBeenCalled()

    window.fire('pointerup', { clientX: 304, clientY: 22 })
    expect(shell.endNativeTabDrag).toHaveBeenCalledExactlyOnceWith(nonce)
    expect(host.finished).toHaveBeenCalledTimes(1)
    expect(isDraggingTab()).toBe(false)

    tab.fire('dragend')
    window.fire('pointermove')
    expect(shell.endNativeTabDrag).toHaveBeenCalledTimes(1)
  })

  it('reports no Escape when no drag has ended', async () => {
    const { shell, window } = await setup()
    window.fire('keyup', { key: 'Escape' })
    expect(shell.cancelNativeTabDrag).not.toHaveBeenCalled()
  })
})

describe('a strip that takes the drag', () => {
  it('marks the slot under the pointer in the source strip, leaving its own tab out, and reports the drop there', async () => {
    const { shell, marks, begin, document } = await setup()
    const { dt } = await begin(0)
    const nonce = dt.data.get(TYPE) ?? ''
    const over = transfer([TYPE])
    const preventDefault = vi.fn()

    document.fire('dragover', { dataTransfer: over, clientX: 160, clientY: 20, preventDefault })
    expect(preventDefault).toHaveBeenCalled()
    expect(over.dropEffect).toBe('move')
    expect(marks.at(-1)).toEqual([101, ['a']])

    document.fire('drop', { dataTransfer: transfer([TYPE], nonce), clientX: 160, clientY: 20 })
    expect(shell.dropNativeTab).toHaveBeenCalledWith(nonce, 101, false)
    expect(marks.at(-1)).toEqual([null, []])
  })

  it('takes a drop over the source toolbar and marks nothing there', async () => {
    const { shell, marks, begin, document } = await setup()
    const { dt } = await begin(0)
    const nonce = dt.data.get(TYPE) ?? ''

    document.fire('dragover', { dataTransfer: transfer([TYPE]), clientX: 160, clientY: 60 })
    expect(marks.at(-1)).toEqual([null, ['a']])
    document.fire('drop', { dataTransfer: transfer([TYPE], nonce), clientX: 160, clientY: 60 })
    expect(shell.dropNativeTab).toHaveBeenCalledWith(nonce, null, false)
  })

  it('reports a drop below the toolbar as such, and marks nothing', async () => {
    const { shell, marks, begin, document } = await setup()
    const { dt } = await begin(0)
    const nonce = dt.data.get(TYPE) ?? ''

    document.fire('dragover', { dataTransfer: transfer([TYPE]), clientX: 160, clientY: 90 })
    expect(marks.at(-1)).toEqual([null, []])
    document.fire('drop', { dataTransfer: transfer([TYPE], nonce), clientX: 160, clientY: 90 })
    expect(shell.dropNativeTab).toHaveBeenCalledWith(nonce, null, true)
  })

  it('takes a drag from another window once main says it is on, marking the slot among every tab, and lets go when it is over', async () => {
    const { shell, marks, drag, document } = await setup()
    const preventDefault = vi.fn()
    document.fire('dragover', { dataTransfer: transfer([TYPE]), clientX: 160, clientY: 20, preventDefault })
    expect(preventDefault).not.toHaveBeenCalled()

    drag.setTarget(true, false)
    document.fire('dragover', { dataTransfer: transfer([TYPE]), clientX: 160, clientY: 20, preventDefault })
    expect(preventDefault).toHaveBeenCalled()
    expect(marks.at(-1)).toEqual([2, []])
    document.fire('drop', { dataTransfer: transfer([TYPE], 'theirs'), clientX: 160, clientY: 20 })
    expect(shell.dropNativeTab).toHaveBeenCalledWith('theirs', 2, false)

    drag.setTarget(false, false)
    expect(marks.at(-1)).toEqual([null, []])
    document.fire('drop', { dataTransfer: transfer([TYPE], 'theirs'), clientX: 160, clientY: 20 })
    expect(shell.dropNativeTab).toHaveBeenCalledTimes(1)
  })

  it('keeps a pinned tab\'s mark within the pinned run', async () => {
    const { marks, drag, document } = await setup({ pinned: true })
    drag.setTarget(true, true)
    document.fire('dragover', { dataTransfer: transfer([TYPE]), clientX: 290, clientY: 20 })
    expect(marks.at(-1)).toEqual([3, []])
  })

  it('ignores a drag that does not carry the tab type, and takes the mark away when the pointer leaves', async () => {
    const { marks, drag, document } = await setup()
    drag.setTarget(true, false)
    const preventDefault = vi.fn()
    document.fire('dragover', { dataTransfer: transfer(['text/plain']), clientX: 160, clientY: 20, preventDefault })
    document.fire('dragenter', { dataTransfer: null, clientX: 160, clientY: 20, preventDefault })
    expect(preventDefault).not.toHaveBeenCalled()
    expect(marks).toEqual([])

    document.fire('dragleave', { dataTransfer: transfer([]), relatedTarget: null })
    expect(marks.at(-1)).toEqual([null, []])
  })
})
