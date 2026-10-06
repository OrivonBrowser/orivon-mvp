import { describe, expect, it, vi } from 'vitest'
import type { OverlayWindow } from '../../../overlays/overlay-types.js'
import type { ShellWindow } from '../../../shell/window-registry.js'
import type { ActiveShare, ShareRegistry } from '../../types.js'
import { SharingBars, sharingBarOverlayFor, SHARING_BAR_OVERLAY } from '../sharing-bar.js'

const tab = (id: string): { id: string } => ({ id })
const share = (id: string, requester: { id: string }, kind: ActiveShare['kind'] = 'screen', startedAt = 1): ActiveShare =>
  ({ id, requester: requester as never, origin: 'https://meet.example', kind, label: id, audio: false, startedAt })

function rig () {
  const mine = tab('mine')
  const theirs = tab('theirs')
  const open = new Set<string>()
  const calls: string[] = []
  const sent: unknown[] = []
  const window = {
    window: { isDestroyed: () => false },
    tabs: { findTabIdByWebContents: (contents: { id: string }) => contents === mine ? 't1' : null },
    overlays: {
      isOpen: (name: string) => open.has(name),
      show: (name: string) => { open.add(name); calls.push('show') },
      close: (name: string) => { open.delete(name); calls.push('close') },
      send: (_name: string, event: unknown) => { sent.push(event) }
    }
  } as unknown as ShellWindow
  let shares: ActiveShare[] = []
  const stop = vi.fn((id: string) => { shares = shares.filter((s) => s.id !== id) })
  const registry: ShareRegistry = { list: () => shares, forRequester: () => [], forCaptured: () => [], capturePending: () => false, onChange: () => () => {}, stop }
  const bars = new SharingBars()
  bars.use(() => [window], () => registry)
  return { bars, window, mine, theirs, calls, sent, stop, setShares: (next: ActiveShare[]) => { shares = next } }
}

describe('SharingBars', () => {
  it('shows the bar in the window of the sharing page, and closes it when the last share ends', () => {
    const r = rig()
    r.bars.sync()
    expect(r.calls).toEqual([])
    r.setShares([share('a', r.mine)])
    r.bars.sync()
    expect(r.calls).toEqual(['show'])
    r.setShares([])
    r.bars.sync()
    expect(r.calls).toEqual(['show', 'close'])
  })

  it('does nothing for a share whose page is in another window', () => {
    const r = rig()
    r.setShares([share('a', r.theirs)])
    r.bars.sync()
    expect(r.calls).toEqual([])
    expect(r.bars.viewFor(r.window)).toBeNull()
  })

  it('tells an open bar about a change instead of showing it again', () => {
    const r = rig()
    r.setShares([share('a', r.mine, 'screen', 1)])
    r.bars.sync()
    r.setShares([share('a', r.mine, 'screen', 1), share('b', r.mine, 'tab', 2)])
    r.bars.sync()
    expect(r.calls).toEqual(['show'])
    expect(r.sent).toEqual([{ type: 'view', view: { text: 'https://meet.example is sharing a tab and 1 more', count: 2 } }])
  })

  it('stays hidden after Hide until a new share starts', () => {
    const r = rig()
    r.setShares([share('a', r.mine)])
    r.bars.sync()
    r.bars.hide(r.window)
    expect(r.calls).toEqual(['show', 'close'])
    r.bars.sync()
    expect(r.calls).toEqual(['show', 'close'])
    r.setShares([share('a', r.mine), share('b', r.mine, 'window', 2)])
    r.bars.sync()
    expect(r.calls).toEqual(['show', 'close', 'show'])
  })

  it('shows a hidden bar again when the chip is clicked, only while there is a share', () => {
    const r = rig()
    r.bars.reveal(r.window)
    expect(r.calls).toEqual([])
    r.setShares([share('a', r.mine)])
    r.bars.sync()
    r.bars.hide(r.window)
    r.bars.reveal(r.window)
    expect(r.calls).toEqual(['show', 'close', 'show'])
  })

  it('stops every share of the window and no other', () => {
    const r = rig()
    r.setShares([share('a', r.mine), share('b', r.mine, 'tab', 2), share('c', r.theirs)])
    r.bars.stopAll(r.window)
    expect(r.stop.mock.calls.map(([id]) => id)).toEqual(['a', 'b'])
  })
})

describe('the sharing bar overlay', () => {
  it('is a top-centre bar that never takes focus and outlives tab switches and navigations', () => {
    const def = sharingBarOverlayFor(new SharingBars())
    expect(def).toMatchObject({ name: SHARING_BAR_OVERLAY, focus: 'never', layer: 'bar', keep: 'fresh', placement: { kind: 'area', at: 'top-center' } })
    expect(def.closeOn).toEqual({ blur: false, tabSwitch: false, navigation: false, layout: false })
    expect(def.height).toEqual({ initial: 44, min: 44, max: 44 })
  })

  it('shows the sentence for its window, and nothing without a share', () => {
    const r = rig()
    const handler = sharingBarOverlayFor(r.bars).attach({ window: r.window } as unknown as OverlayWindow)
    expect(handler.show?.(undefined)).toBeUndefined()
    r.setShares([share('a', r.mine, 'window')])
    expect(handler.show?.(undefined)).toEqual({ text: 'https://meet.example is sharing a window', count: 1 })
  })

  it('answers Stop sharing and Hide, and nothing with another key or word', () => {
    const r = rig()
    r.setShares([share('a', r.mine)])
    r.bars.sync()
    const handler = sharingBarOverlayFor(r.bars).attach({ window: r.window } as unknown as OverlayWindow)
    for (const command of [{ type: 'stop', id: 'a' }, { type: 'stop', origin: 'x' }, { type: 'restart' }, 'stop', null, undefined, {}]) handler.request(command)
    expect(r.stop).not.toHaveBeenCalled()
    expect(r.calls).toEqual(['show'])
    handler.request({ type: 'hide' })
    expect(r.calls).toEqual(['show', 'close'])
    handler.request({ type: 'stop' })
    expect(r.stop).toHaveBeenCalledWith('a')
  })
})
