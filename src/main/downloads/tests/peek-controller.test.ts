import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StartInfo } from '../download-service.js'
import type { DownloadEntry } from '../download-types.js'
import { MIN_PEEK_GAP_MS, PEEK_LINGER_MS, PeekController } from '../peek-controller.js'
import type { PeekDeps } from '../peek-controller.js'

interface Win { readonly name: string }
const A: Win = { name: 'a' }
const B: Win = { name: 'b' }
const info = { id: 'x' } as unknown as StartInfo

function rig (over: Partial<PeekDeps<Win>> = {}) {
  let clock = 10_000
  let peekOpen = false
  let active = 1
  let list: DownloadEntry[] = []
  const timers: Array<{ run: () => void, ms: number, live: boolean }> = []
  const requested: Win[] = []
  const closed: Win[] = []
  const deps: PeekDeps<Win> = {
    showBubble: () => true,
    buttonAllowed: () => true,
    windowOf: () => A,
    popupOpen: () => false,
    peekOpen: () => peekOpen,
    requestPeek: (window) => { requested.push(window) },
    closePeek: (window) => { closed.push(window); peekOpen = false },
    list: () => list,
    active: () => active,
    now: () => clock,
    schedule: (run, ms) => { const timer = { run, ms, live: true }; timers.push(timer); return timer },
    cancel: (timer) => { (timer as { live: boolean }).live = false },
    ...over
  }
  const controller = new PeekController<Win>(deps)
  return {
    controller, requested, closed, timers,
    open: () => { peekOpen = true },
    advance: (ms: number) => { clock += ms },
    setActive: (n: number) => { active = n },
    setList: (next: DownloadEntry[]) => { list = next },
    live: () => timers.filter((timer) => timer.live)
  }
}

describe('opening the peek', () => {
  let r: ReturnType<typeof rig>
  beforeEach(() => { r = rig() })

  it('asks the window of the tab that started the download', () => {
    r.controller.started(info)
    expect(r.requested).toEqual([A])
  })

  it('does nothing when the setting is off, when the button is never shown, or when no window holds the tab', () => {
    for (const over of [{ showBubble: () => false }, { buttonAllowed: () => false }, { windowOf: () => undefined }]) {
      const other = rig(over)
      other.controller.started(info)
      expect(other.requested).toEqual([])
    }
  })

  it('does not open over another popup, or when the peek or bubble is already there', () => {
    const popup = rig({ popupOpen: () => true })
    popup.controller.started(info)
    expect(popup.requested).toEqual([])
    r.open()
    r.controller.started(info)
    expect(r.requested).toEqual([])
  })

  it('asks at most once every two seconds for one window, and independently for another', () => {
    r.controller.started(info)
    r.advance(MIN_PEEK_GAP_MS - 1)
    r.controller.started(info)
    expect(r.requested).toHaveLength(1)
    r.advance(1)
    r.controller.started(info)
    expect(r.requested).toHaveLength(2)
    const two = rig({ windowOf: (started) => started === info ? A : B })
    two.controller.started(info)
    expect(two.requested).toEqual([A])
  })
})

describe('closing the peek', () => {
  it('closes it five seconds after nothing is left running', () => {
    const r = rig()
    r.controller.started(info)
    r.open()
    r.setActive(0)
    r.controller.opened(A)
    expect(r.live()).toHaveLength(1)
    expect(r.live()[0]?.ms).toBe(PEEK_LINGER_MS)
    r.live()[0]?.run()
    expect(r.closed).toEqual([A])
  })

  it('waits while a download is running, and starts counting when the last one ends', () => {
    const r = rig()
    r.open()
    r.controller.opened(A)
    expect(r.live()).toHaveLength(0)
    r.setActive(0)
    r.controller.changed(null)
    expect(r.live()).toHaveLength(1)
  })

  it('does not count progress, only a change of state', () => {
    const r = rig()
    r.open()
    r.controller.opened(A)
    r.setActive(0)
    r.controller.changed({ state: 'progressing' } as DownloadEntry)
    expect(r.live()).toHaveLength(0)
  })

  it('stays while a file is held for an answer', () => {
    const r = rig()
    r.open()
    r.setActive(0)
    r.setList([{ id: 'h', state: 'held' } as DownloadEntry])
    r.controller.opened(A)
    expect(r.live()).toHaveLength(0)
    r.setList([])
    r.controller.changed(null)
    expect(r.live()).toHaveLength(1)
  })

  it('stays while the pointer is over it, and counts again when it leaves', () => {
    const r = rig()
    r.open()
    r.setActive(0)
    r.controller.opened(A)
    r.controller.pointer(A, true)
    expect(r.live()).toHaveLength(0)
    r.controller.pointer(A, false)
    expect(r.live()).toHaveLength(1)
  })

  it('does not close it when the pointer came back before the timer ran', () => {
    const r = rig()
    r.open()
    r.setActive(0)
    r.controller.opened(A)
    const timer = r.live()[0]
    r.controller.pointer(A, true)
    timer?.run()
    expect(r.closed).toEqual([])
  })

  it('forgets a window when its peek closes, and a new download cancels a pending close', () => {
    const r = rig()
    r.open()
    r.setActive(0)
    r.controller.opened(A)
    r.controller.started(info)
    expect(r.live()).toHaveLength(0)
    r.controller.closed(A)
    r.controller.changed(null)
    expect(r.live()).toHaveLength(0)
  })

  it('schedules nothing for a peek that is no longer open', () => {
    const vague = vi.fn()
    const r = rig({ schedule: vague })
    r.setActive(0)
    r.controller.opened(A)
    expect(vague).not.toHaveBeenCalled()
  })
})
