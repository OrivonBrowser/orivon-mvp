import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabSignalContext } from '../tab-signals.js'
import type { TabRecord } from '../tab-types.js'

const theme = vi.hoisted(() => ({ dark: true, listeners: [] as Array<() => void> }))
vi.mock('electron', () => ({
  nativeTheme: {
    get shouldUseDarkColors () { return theme.dark },
    on: (_event: string, listener: () => void) => { theme.listeners.push(listener) },
    removeListener: () => {}
  }
}))
vi.mock('../../sad-tab/sad-tab-controller.js', () => ({ syncSadTab: vi.fn(), watchActivations: vi.fn() }))

const { crashedSignal } = await import('../signals/crashed.js')
const { watchPageDialogs } = await import('../page-dialogs.js')
const { syncSadTab, watchActivations } = await import('../../sad-tab/sad-tab-controller.js')
const { troubleOf } = await import('../../sad-tab/sad-tab-state.js')

interface Rig {
  wc: EventEmitter & { isDestroyed: () => boolean }
  record: TabRecord
  view: { setBackgroundColor: ReturnType<typeof vi.fn> }
  emitState: ReturnType<typeof vi.fn>
  owner: object
}

function rig (options: { shown?: boolean, isDashboardTab?: boolean, internalPage?: string | null, services?: boolean } = {}): Rig {
  const wc = new EventEmitter() as Rig['wc']
  wc.isDestroyed = () => false
  const owner = {}
  const emitState = vi.fn()
  const view = { setBackgroundColor: vi.fn() }
  const record = {
    crashed: null,
    isDashboardTab: options.isDashboardTab ?? false,
    internalPage: options.internalPage ?? null,
    host: { emitState, services: options.services === false ? undefined : { tabLifecycle: {}, windows: { findOwner: () => owner } } }
  } as unknown as TabRecord
  crashedSignal.wire?.({ wc, record, view, shown: () => options.shown ?? true } as unknown as TabSignalContext)
  return { wc, record, view, emitState, owner }
}

beforeEach(() => { vi.mocked(syncSadTab).mockClear() })

describe('the crashed signal -- a page blocked on its own dialog', () => {
  const blockOnDialog = (wc: Rig['wc']): void => {
    const mainFrame = { origin: 'https://page.example', detached: false }
    Object.assign(wc, { ipc: { on: vi.fn() }, mainFrame })
    wc.on('-run-dialog', () => {})
    const waiting = (_target: unknown, spec: { cancelId: number }, options?: { signal?: AbortSignal }): Promise<unknown> =>
      new Promise((resolve) => { options?.signal?.addEventListener('abort', () => { resolve({ response: spec.cancelId, checkboxChecked: false }) }) })
    watchPageDialogs(wc as never, () => true, waiting as never)
    wc.emit('-run-dialog', { frame: mainFrame, dialogType: 'confirm', messageText: 'wait', defaultPromptText: '' }, () => {})
  }

  it('is waiting for the person, not hung: its silence marks nothing', () => {
    const { wc, record, emitState } = rig()
    blockOnDialog(wc)

    wc.emit('unresponsive')

    expect(troubleOf(record)).toBeNull()
    expect(emitState).not.toHaveBeenCalled()
    expect(syncSadTab).not.toHaveBeenCalled()
  })

  it('is hung again once no dialog is open', async () => {
    const { wc, record } = rig()
    blockOnDialog(wc)
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    await new Promise((resolve) => { setTimeout(resolve, 0) })

    wc.emit('unresponsive')

    expect(troubleOf(record)).not.toBeNull()
  })
})

describe('the crashed signal', () => {
  it('watches tab activations through the shared lifecycle', () => {
    rig()
    expect(watchActivations).toHaveBeenCalled()
  })

  it('records why a page died, pushes the state and tells the window', () => {
    const { wc, record, emitState, owner } = rig()
    for (const reason of ['crashed', 'oom', 'killed']) {
      record.crashed = null
      wc.emit('render-process-gone', {}, { reason, exitCode: 9 })
      expect(record.crashed).toBe(reason)
    }
    expect(emitState).toHaveBeenCalledTimes(3)
    expect(syncSadTab).toHaveBeenLastCalledWith(owner)
  })

  it('ignores a clean exit', () => {
    const { wc, record, emitState } = rig()
    wc.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 })
    expect(record.crashed).toBeNull()
    expect(emitState).not.toHaveBeenCalled()
  })

  it('ignores a view that is swapped out of its tab', () => {
    const { wc, record, emitState } = rig({ shown: false })
    wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 9 })
    wc.emit('unresponsive')
    expect(record.crashed).toBeNull()
    expect(troubleOf(record)).toBeNull()
    expect(emitState).not.toHaveBeenCalled()
  })

  it('never touches contents that were destroyed', () => {
    const { wc, record, emitState } = rig()
    wc.isDestroyed = () => true
    wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 9 })
    expect(record.crashed).toBeNull()
    expect(emitState).not.toHaveBeenCalled()
  })

  it('clears the flag when the page navigates or starts loading, and tells the window', () => {
    for (const event of ['did-navigate', 'did-start-loading']) {
      const { wc, record, emitState } = rig()
      wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 9 })
      emitState.mockClear()
      wc.emit(event)
      expect(record.crashed).toBeNull()
      expect(emitState).toHaveBeenCalledTimes(1)
    }
  })

  it('pushes nothing for a navigation of a healthy page', () => {
    const { wc, emitState } = rig()
    wc.emit('did-navigate')
    wc.emit('did-start-loading')
    expect(emitState).not.toHaveBeenCalled()
  })

  it('paints a dead ordinary view in the shell surface and puts the default white back on recovery', () => {
    const { wc, view } = rig()
    wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 9 })
    expect(view.setBackgroundColor).toHaveBeenLastCalledWith('#17181c')
    wc.emit('did-start-loading')
    expect(view.setBackgroundColor).toHaveBeenLastCalledWith('#FFFFFF')
  })

  it('repaints a dead view when the theme changes, and stops once it recovered or was destroyed', () => {
    const { wc, view } = rig()
    const other = rig()
    wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 9 })
    other.wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 9 })
    theme.dark = false
    view.setBackgroundColor.mockClear()
    other.view.setBackgroundColor.mockClear()
    for (const listener of theme.listeners) listener()
    expect(view.setBackgroundColor).toHaveBeenLastCalledWith('#f4f4f8')
    wc.emit('did-start-loading')
    other.wc.emit('destroyed')
    view.setBackgroundColor.mockClear()
    other.view.setBackgroundColor.mockClear()
    for (const listener of theme.listeners) listener()
    expect(view.setBackgroundColor).not.toHaveBeenCalled()
    expect(other.view.setBackgroundColor).not.toHaveBeenCalled()
    theme.dark = true
  })

  it('leaves the colour of the dashboard and of a shell page alone', () => {
    for (const options of [{ isDashboardTab: true }, { internalPage: 'settings' }]) {
      const { wc, view } = rig(options)
      wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 9 })
      wc.emit('did-navigate')
      expect(view.setBackgroundColor).not.toHaveBeenCalled()
    }
  })

  it('tracks a page that stops answering, and clears it when it answers', () => {
    const { wc, record, owner } = rig()
    wc.emit('unresponsive')
    expect(troubleOf(record)).toEqual({ kind: 'unresponsive' })
    expect(syncSadTab).toHaveBeenLastCalledWith(owner)
    wc.emit('responsive')
    expect(troubleOf(record)).toBeNull()
  })

  it('does not call a crashed page unresponsive', () => {
    const { wc, record } = rig()
    wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 9 })
    wc.emit('unresponsive')
    expect(troubleOf(record)).toEqual({ kind: 'crashed', reason: 'crashed' })
  })

  it('still records a crash where no shell services exist', () => {
    const { wc, record } = rig({ services: false })
    wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 9 })
    expect(record.crashed).toBe('crashed')
    expect(syncSadTab).not.toHaveBeenCalled()
  })
})
