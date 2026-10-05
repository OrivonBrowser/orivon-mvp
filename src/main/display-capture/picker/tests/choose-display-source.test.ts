import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SlotAsk } from '../../../overlays/tab-slots.js'
import type { ShellWindow } from '../../../shell/window-registry.js'
import type { DisplayChoice, DisplayRequest } from '../../types.js'

const slots = vi.hoisted(() => ({ asks: [] as unknown[], cancel: vi.fn() }))
vi.mock('../../../overlays/tab-slots.js', () => ({
  requestSlot: (ask: unknown) => { slots.asks.push(ask); return { cancel: slots.cancel } },
  slotClosed: vi.fn()
}))

const { createDisplayChooser } = await import('../choose-display-source.js')
const { PickerStore } = await import('../picker-store.js')

const window = {} as ShellWindow
const request: DisplayRequest = { tab: { id: 1 } as never, origin: 'https://meet.example', isApp: false, audio: false, hints: {} }
const lastAsk = (): SlotAsk => slots.asks.at(-1) as SlotAsk

function setup (found = true) {
  const store = new PickerStore()
  const choose = createDisplayChooser({ store, findTab: () => found ? { window, tabId: 't1' } : null })
  return { store, choose }
}

beforeEach(() => { slots.asks.length = 0; slots.cancel.mockClear() })

describe('createDisplayChooser', () => {
  it('asks for the centre slot of the window that holds the tab, naming the question', async () => {
    const { store, choose } = setup()
    const pending = choose(request, new AbortController().signal)
    expect(lastAsk()).toMatchObject({ window, tabId: 't1', slot: 'center', overlay: 'screen-share-picker' })
    const { id } = lastAsk().payload as { id: string }
    expect(store.get(id)?.request).toBe(request)
    const choice: DisplayChoice = { kind: 'screen', source: { id: 'screen:0:0', name: 'Entire screen' }, systemAudio: false, label: 'Entire screen' }
    store.settle(id, choice)
    expect(await pending).toBe(choice)
  })

  it.each(['request', 'escape', 'navigation', 'tab-closed', 'window-closed', 'queue-full'] as const)('answers no when the slot ends with %s', async (reason) => {
    const { choose } = setup()
    const pending = choose(request, new AbortController().signal)
    lastAsk().closed(reason)
    expect(await pending).toBeNull()
  })

  it('answers no, and withdraws the ask, when the signal aborts', async () => {
    const { store, choose } = setup()
    const controller = new AbortController()
    const pending = choose(request, controller.signal)
    const { id } = lastAsk().payload as { id: string }
    controller.abort()
    expect(await pending).toBeNull()
    expect(slots.cancel).toHaveBeenCalledTimes(1)
    expect(store.get(id)).toBeUndefined()
  })

  it('answers no without asking when the signal is already aborted or no tab holds the page', async () => {
    const aborted = new AbortController()
    aborted.abort()
    expect(await setup().choose(request, aborted.signal)).toBeNull()
    expect(await setup(false).choose(request, new AbortController().signal)).toBeNull()
    expect(slots.asks).toEqual([])
  })
})
