import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindShareRegistry } from '../../display-capture/bindings.js'
import { shareRegistryRebound } from '../../display-capture/indicators/share-events.js'
import type { ActiveShare, ShareRegistry } from '../../display-capture/types.js'
import { sharingSignal, watchShares } from '../signals/sharing.js'
import { signalState, wireTabSignals } from '../tab-signals.js'
import { SHELL_STATE_PARTS } from '../shell-state-parts.js'
import { sharingStatePart } from '../state/sharing.js'
import type { TabsSnapshot } from '../tab-types.js'
import type { WindowContext } from '../window-context.js'

type Page = EventEmitter & { id: number }
const page = (id: number): Page => Object.assign(new EventEmitter(), { id })
const share = (id: string, requester: Page, kind: ActiveShare['kind'], startedAt: number, captured?: Page): ActiveShare =>
  ({ id, requester: requester as never, origin: 'https://meet.example', kind, label: id, ...(captured === undefined ? {} : { captured: captured as never }), audio: false, startedAt })

function fakeRegistry (): ShareRegistry & { set: (next: ActiveShare[]) => void } {
  let shares: ActiveShare[] = []
  const listeners = new Set<() => void>()
  return {
    list: () => shares,
    forRequester: (contents) => shares.filter((s) => s.requester === contents),
    forCaptured: (contents) => shares.filter((s) => s.captured === contents),
    capturePending: () => false,
    onChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    stop: () => {},
    set: (next) => { shares = next; for (const listener of [...listeners]) listener() }
  }
}

function wired (wc: Page) {
  const emitState = vi.fn()
  const record = { host: { emitState }, view: { webContents: wc } } as never
  wireTabSignals('t', record, [sharingSignal])
  return { record, emitState }
}

afterEach(() => { bindShareRegistry(undefined); shareRegistryRebound() })

describe('the sharing signal', () => {
  it('adds nothing to a tab that is not part of a share', () => {
    expect(signalState({ host: {} } as never, page(1) as never, [sharingSignal])).toEqual({})
    expect(signalState({ host: {} } as never, undefined, [sharingSignal])).toEqual({})
  })

  it('marks the page that shares with its newest share, and the tab that is shown', () => {
    const registry = fakeRegistry()
    bindShareRegistry(registry)
    const requester = page(1)
    const shown = page(2)
    registry.set([share('a', requester, 'screen', 1), share('b', requester, 'tab', 2, shown)])
    expect(signalState({ host: {} } as never, requester as never, [sharingSignal])).toEqual({ sharing: 'tab' })
    expect(signalState({ host: {} } as never, shown as never, [sharingSignal])).toEqual({ shared: true })
    registry.set([share('a', requester, 'screen', 1)])
    expect(signalState({ host: {} } as never, requester as never, [sharingSignal])).toEqual({ sharing: 'screen' })
    expect(signalState({ host: {} } as never, shown as never, [sharingSignal])).toEqual({})
  })

  it('is the same tab in both roles when a page shares itself', () => {
    const registry = fakeRegistry()
    bindShareRegistry(registry)
    const self = page(1)
    registry.set([share('a', self, 'tab', 1, self)])
    expect(signalState({ host: {} } as never, self as never, [sharingSignal])).toEqual({ sharing: 'tab', shared: true })
  })
})

describe('watchShares', () => {
  it('asks only the tabs a started or ended share touches to push their state', () => {
    const registry = fakeRegistry()
    const requester = page(1); const shown = page(2); const bystander = page(3)
    const r = wired(requester); const s = wired(shown); const b = wired(bystander)
    const stop = watchShares(() => registry, (listener) => registry.onChange(listener))
    registry.set([share('a', requester, 'tab', 1, shown)])
    expect([r.emitState, s.emitState, b.emitState].map((fn) => fn.mock.calls.length)).toEqual([1, 1, 0])
    registry.set([share('a', requester, 'tab', 1, shown)])
    expect([r.emitState, s.emitState].map((fn) => fn.mock.calls.length)).toEqual([1, 1])
    registry.set([])
    expect([r.emitState, s.emitState, b.emitState].map((fn) => fn.mock.calls.length)).toEqual([2, 2, 0])
    stop()
  })

  it('stops asking for a tab whose page is gone', () => {
    const registry = fakeRegistry()
    const requester = page(1)
    const { emitState } = wired(requester)
    const stop = watchShares(() => registry, (listener) => registry.onChange(listener))
    requester.emit('destroyed')
    registry.set([share('a', requester, 'screen', 1)])
    expect(emitState).not.toHaveBeenCalled()
    stop()
  })
})

describe('the sharing state part', () => {
  const rig = (wc: Page | undefined) => ({
    ctx: { window: { tabs: { liveWebContents: () => wc } } } as unknown as WindowContext,
    tabs: (activeTabId: string | null): TabsSnapshot => ({ activeTabId }) as unknown as TabsSnapshot
  })

  it('is one of the window state parts', () => {
    expect(SHELL_STATE_PARTS.map((part) => part.name)).toContain('sharing')
  })

  it('names the newest share of the page in front, with how many it has', () => {
    const registry = fakeRegistry()
    bindShareRegistry(registry)
    const wc = page(1)
    const { ctx, tabs } = rig(wc)
    expect(sharingStatePart.read(ctx, tabs('a'))).toEqual({ sharing: null })
    registry.set([share('a', wc, 'screen', 1), share('b', wc, 'window', 2)])
    expect(sharingStatePart.read(ctx, tabs('a'))).toEqual({ sharing: { kind: 'window', origin: 'https://meet.example', count: 2 } })
  })

  it('is null with no active tab or no live page', () => {
    const registry = fakeRegistry()
    bindShareRegistry(registry)
    const wc = page(1)
    registry.set([share('a', wc, 'screen', 1)])
    expect(sharingStatePart.read(rig(wc).ctx, rig(wc).tabs(null))).toEqual({ sharing: null })
    expect(sharingStatePart.read(rig(undefined).ctx, rig(undefined).tabs('a'))).toEqual({ sharing: null })
  })

  it('pushes when a share starts or ends', () => {
    const registry = fakeRegistry()
    bindShareRegistry(registry)
    shareRegistryRebound()
    const push = vi.fn()
    const stop = sharingStatePart.watch?.({} as WindowContext, push)
    registry.set([share('a', page(1), 'tab', 1)])
    expect(push).toHaveBeenCalledTimes(1)
    stop?.()
  })
})
