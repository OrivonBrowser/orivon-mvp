import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'

// A link or redirect into an address served from the cache moves the tab to that address's
// partition before anything commits; every other navigation is left to run.

const repartitionView = vi.fn()
vi.mock('../tab-parking.js', () => ({ repartitionView }))
const partitionChanged = vi.fn()
const partitionAfterFileBlock = vi.fn()
vi.mock('../tab-partition.js', () => ({ partitionChanged, partitionAfterFileBlock }))
const isNavigationHeld = vi.fn(() => false)
vi.mock('../navigation-hold.js', () => ({ isNavigationHeld }))

const { repartitionBeforeCommit, repartitionOnFileBlock } = await import('../pre-partition.js')

function rig (record: Record<string, unknown> = {}) {
  const wc = Object.assign(new EventEmitter(), { isDestroyed: () => false }) as unknown as WebContents & EventEmitter
  const view = {}
  const tab = { view, partition: undefined, isDashboardTab: false, internalPage: null, ...record }
  let on = true
  repartitionBeforeCommit(wc, 'tab-1', tab as never, () => on)
  const fire = (name: 'will-navigate' | 'will-redirect', extra: Record<string, unknown> = {}) => {
    const event = { url: 'https://app.eth/', isMainFrame: true, defaultPrevented: false, preventDefault: vi.fn(), ...extra }
    wc.emit(name, event)
    return event
  }
  return { fire, tab, hide: () => { on = false } }
}

beforeEach(() => { repartitionView.mockReset(); partitionChanged.mockReset(); partitionAfterFileBlock.mockReset(); isNavigationHeld.mockReset().mockReturnValue(false) })

describe('repartitionBeforeCommit', () => {
  it.each(['will-navigate', 'will-redirect'] as const)('stops a main-frame %s into a cache-served partition and loads it there', async (name) => {
    partitionChanged.mockReturnValue({ to: 'persist:app-1' })
    const { fire } = rig()
    const event = fire(name)
    expect(event.preventDefault).toHaveBeenCalled()
    await new Promise((resolve) => setImmediate(resolve))
    expect(repartitionView).toHaveBeenCalledWith('tab-1', expect.anything(), 'https://app.eth/', 'persist:app-1')
  })

  it.each(['ipfs://app.eth/', 'ipns://app.eth/'])('stops a link written as %s and loads the address it is served at', async (shown) => {
    partitionChanged.mockReturnValue({ to: 'persist:app-1' })
    const { fire } = rig()
    const event = fire('will-navigate', { url: shown })
    expect(event.preventDefault).toHaveBeenCalled()
    expect(partitionChanged).toHaveBeenCalledWith('https://app.eth/', undefined)
    await new Promise((resolve) => setImmediate(resolve))
    expect(repartitionView).toHaveBeenCalledWith('tab-1', expect.anything(), 'https://app.eth/', 'persist:app-1')
  })

  it('leaves a navigation that stays in the tab\'s partition, or leaves for the open web', () => {
    partitionChanged.mockReturnValue(undefined)
    expect(rig().fire('will-navigate').preventDefault).not.toHaveBeenCalled()
    partitionChanged.mockReturnValue({ to: undefined })
    expect(rig().fire('will-navigate').preventDefault).not.toHaveBeenCalled()
  })

  it('ignores a subframe, an already prevented navigation, a held one and a tab that is not showing', () => {
    partitionChanged.mockReturnValue({ to: 'persist:app-1' })
    const r = rig()
    expect(r.fire('will-navigate', { isMainFrame: false }).preventDefault).not.toHaveBeenCalled()
    expect(r.fire('will-navigate', { defaultPrevented: true }).preventDefault).not.toHaveBeenCalled()
    isNavigationHeld.mockReturnValue(true)
    expect(r.fire('will-navigate').preventDefault).not.toHaveBeenCalled()
    isNavigationHeld.mockReturnValue(false)
    r.hide()
    expect(r.fire('will-navigate').preventDefault).not.toHaveBeenCalled()
  })

  it('leaves the dashboard and an internal page alone', () => {
    partitionChanged.mockReturnValue({ to: 'persist:app-1' })
    expect(rig({ isDashboardTab: true }).fire('will-navigate').preventDefault).not.toHaveBeenCalled()
    expect(rig({ internalPage: 'settings' }).fire('will-navigate').preventDefault).not.toHaveBeenCalled()
  })

  it('does not load the address when the tab\'s view was replaced before the turn ended', async () => {
    partitionChanged.mockReturnValue({ to: 'persist:app-1' })
    const r = rig()
    r.fire('will-navigate')
    r.tab.view = {}
    await new Promise((resolve) => setImmediate(resolve))
    expect(repartitionView).not.toHaveBeenCalled()
  })
})

describe('repartitionOnFileBlock', () => {
  const FILE = 'file:///home/u/app/index.html'

  function blockRig (record: Record<string, unknown> = {}) {
    const wc = Object.assign(new EventEmitter(), { isDestroyed: () => false }) as unknown as WebContents & EventEmitter
    const tab = { view: {}, partition: 'persist:orivon-local-files', isDashboardTab: false, internalPage: null, ...record }
    let on = true
    repartitionOnFileBlock(wc, 'tab-1', tab as never, () => on)
    return { fail: (code = -20, url = FILE, isMainFrame = true) => wc.emit('did-fail-load', {}, code, 'blocked', url, isMainFrame), hide: () => { on = false }, tab }
  }

  it('moves the tab to the session the file belongs in, after the event, and loads it there', async () => {
    partitionAfterFileBlock.mockReturnValue({ to: 'persist:local-abc' })
    const { fail } = blockRig()

    fail()
    expect(repartitionView).not.toHaveBeenCalled()
    await new Promise((resolve) => setImmediate(resolve))

    expect(partitionAfterFileBlock).toHaveBeenCalledWith(FILE, -20, true, 'persist:orivon-local-files')
    expect(repartitionView).toHaveBeenCalledWith('tab-1', expect.anything(), FILE, 'persist:local-abc')
  })

  it('does nothing when the rule says the tab is where the file belongs', async () => {
    partitionAfterFileBlock.mockReturnValue(undefined)
    blockRig().fail()
    await new Promise((resolve) => setImmediate(resolve))
    expect(repartitionView).not.toHaveBeenCalled()
  })

  it('leaves a tab that is not showing, the dashboard and an internal page alone', async () => {
    partitionAfterFileBlock.mockReturnValue({ to: 'persist:local-abc' })
    const hidden = blockRig()
    hidden.hide()
    hidden.fail()
    blockRig({ isDashboardTab: true }).fail()
    blockRig({ internalPage: 'settings' }).fail()
    await new Promise((resolve) => setImmediate(resolve))
    expect(repartitionView).not.toHaveBeenCalled()
  })

  it('does not load the file when the tab\'s view was replaced before the turn ended', async () => {
    partitionAfterFileBlock.mockReturnValue({ to: 'persist:local-abc' })
    const r = blockRig()
    r.fail()
    r.tab.view = {}
    await new Promise((resolve) => setImmediate(resolve))
    expect(repartitionView).not.toHaveBeenCalled()
  })
})
