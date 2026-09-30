import { describe, expect, it, vi } from 'vitest'
import type { OverlayHandler, OverlayWindow } from '../../overlays/overlay-types.js'
import { chooserOverlayFor } from '../chooser-overlay.js'
import { ChooserStore, MAX_ITEMS } from '../chooser-store.js'
import type { ChooserSpec, ChooserView } from '../chooser-store.js'

const SPEC: ChooserSpec = {
  title: 'Choose a certificate', origin: 'a.test', line: 'a.test asks you to identify yourself.', confirm: 'Use certificate', empty: 'None.',
  items: [{ id: '0', title: 'Alice', sub: 'Issued by CA', meta: 'Expires 1 Jan' }, { id: '1', title: 'Bob' }]
}

function setup (): { store: ChooserStore, handler: OverlayHandler, window: object, close: ReturnType<typeof vi.fn>, state: { active: string } } {
  let n = 0
  const store = new ChooserStore(() => `q${String(++n)}`)
  const state = { active: 't1' }
  const window = { tabs: { getState: () => ({ activeTabId: state.active }) } }
  const close = vi.fn()
  const handler = chooserOverlayFor(store).attach({ window, services: {}, send: vi.fn(), close } as unknown as OverlayWindow)
  return { store, handler, window, close, state }
}

describe('ChooserStore', () => {
  it('cuts what a caller hands in down to what a row can show', () => {
    const store = new ChooserStore(() => 'q')
    const items = [{ id: 'a', title: 't'.repeat(500), sub: '' }, { id: 'a', title: 'dup' }, { id: '', title: 'no id' }, ...Array.from({ length: 300 }, (_, i) => ({ id: `n${String(i)}`, title: 'x' }))]
    store.add({}, 't', { ...SPEC, items })
    const view = store.get('q')?.view as ChooserView
    expect(view.items).toHaveLength(MAX_ITEMS)
    expect(view.items[0]).toEqual({ id: 'a', title: 't'.repeat(200) })
    expect(view.items.map((item) => item.id).filter((id) => id === 'a')).toHaveLength(1)
  })

  it('resolves once, and only with an id it offered', async () => {
    const store = new ChooserStore(() => 'q')
    const { answer } = store.add({}, 't', SPEC)
    expect(store.resolve('q', 'nope')).toBe(false)
    expect(store.resolve('q', '1')).toBe(true)
    expect(store.resolve('q', null)).toBe(false)
    expect(await answer).toBe('1')
  })

  it('resolves null on a cancel', async () => {
    const store = new ChooserStore(() => 'q')
    const { answer } = store.add({}, 't', SPEC)
    store.resolve('q', null)
    expect(await answer).toBeNull()
  })
})

describe('the chooser overlay', () => {
  it('is a centred bar-layer sheet that goes with the tab and the page', () => {
    const def = chooserOverlayFor(new ChooserStore())
    expect(def).toMatchObject({ name: 'chooser', placement: { kind: 'area', at: 'center', width: 440 }, focus: 'take', layer: 'bar', keep: 'fresh' })
    expect(def.closeOn).toEqual({ blur: false, tabSwitch: true, navigation: true, layout: false })
  })

  it('shows its question to the window and tab it was asked in', () => {
    const s = setup()
    s.store.add(s.window, 't1', SPEC)
    expect((s.handler.show?.({ id: 'q1' }) as ChooserView).items).toHaveLength(2)
    s.state.active = 't2'
    expect(s.handler.show?.({ id: 'q1' })).toBeUndefined()
    s.state.active = 't1'
    s.store.add({}, 't1', SPEC)
    expect(s.handler.show?.({ id: 'q2' })).toBeUndefined()
    expect(s.handler.show?.({ id: 5 })).toBeUndefined()
  })

  it('takes back only an id that was offered, and closes', async () => {
    const s = setup()
    const { answer } = s.store.add(s.window, 't1', SPEC)
    s.handler.show?.({ id: 'q1' })
    s.handler.request({ type: 'choose', id: 'q1', item: '7' })
    expect(s.close).not.toHaveBeenCalled()
    s.handler.request({ type: 'choose', id: 'q1', item: '1' })
    expect(await answer).toBe('1')
    expect(s.close).toHaveBeenCalledOnce()
  })

  it('cancels on request, and refuses malformed commands and questions not on screen', async () => {
    const s = setup()
    const { answer } = s.store.add(s.window, 't1', SPEC)
    for (const bad of [undefined, 'cancel', { type: 'choose', id: 'q1' }, { type: 'choose', id: 'q1', item: 1 }, { type: 'cancel', id: 'q1', extra: 1 }, { type: 'cancel', id: 'q1', item: '0' }]) s.handler.request(bad)
    s.handler.request({ type: 'cancel', id: 'q1' })
    expect(s.close).not.toHaveBeenCalled()
    s.handler.show?.({ id: 'q1' })
    s.handler.request({ type: 'cancel', id: 'q1' })
    expect(await answer).toBeNull()
    expect(s.close).toHaveBeenCalledOnce()
  })

  it('holds a second question behind the first through the tab slots, and answers it after the first', async () => {
    const s = setup()
    const first = s.store.add(s.window, 't1', SPEC)
    const second = s.store.add(s.window, 't1', SPEC)
    s.handler.show?.({ id: 'q1' })
    s.handler.request({ type: 'choose', id: 'q1', item: '0' })
    expect(await first.answer).toBe('0')
    // The second is shown next by the slot, which calls show again with its own id.
    expect((s.handler.show?.({ id: 'q2' }) as ChooserView).id).toBe('q2')
    s.handler.request({ type: 'cancel', id: 'q2' })
    expect(await second.answer).toBeNull()
  })
})
