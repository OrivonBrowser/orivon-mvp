import { describe, expect, it, vi } from 'vitest'
import { enteringPage, forNewlyServed, isEnteringPage, reloadStalePage } from '../stale-pages.js'

// An origin the shell starts to serve where websites run is settled once, when it starts.

const KEPT = 'https://kept.eth'
const OTHER = 'https://other.eth'

function rig (initial: readonly string[]) {
  let served = [...initial]
  let changed: (() => void) | undefined
  const started: string[] = []
  const stop = forNewlyServed({
    served: () => served,
    onServingChange: (listener) => { changed = listener; return () => { changed = undefined } }
  }, (origin) => { started.push(origin) })
  return { started, serve: (...next: string[]) => { served = next; changed?.() }, stop, listening: () => changed !== undefined }
}

describe('the origins the shell starts to serve', () => {
  it('names each origin once, as it starts', () => {
    const { started, serve } = rig([])
    serve(KEPT)
    serve(KEPT, OTHER)
    expect(started).toEqual([KEPT, OTHER])
  })

  it('names nothing for an origin that was served already, or for one whose serving stops', () => {
    const { started, serve } = rig([KEPT])
    serve(KEPT, OTHER)
    serve(OTHER)
    expect(started).toEqual([OTHER])
  })

  it('names an origin again when it is served anew after it stopped', () => {
    const { started, serve } = rig([])
    serve(KEPT)
    serve()
    serve(KEPT)
    expect(started).toEqual([KEPT, KEPT])
  })

  it('goes on to the next origin when one cannot be settled', () => {
    const started: string[] = []
    let changed: (() => void) | undefined
    let served: string[] = []
    forNewlyServed({ served: () => served, onServingChange: (listener) => { changed = listener; return () => {} } }, (origin) => { if (origin === KEPT) throw new Error('gone'); started.push(origin) })
    served = [KEPT, OTHER]
    expect(() => { changed?.() }).not.toThrow()
    expect(started).toEqual([OTHER])
  })

  it('stops listening when told to', () => {
    const { stop, listening } = rig([])
    expect(listening()).toBe(true)
    stop()
    expect(listening()).toBe(false)
  })
})

describe('reloading one stale page', () => {
  function fakePage () {
    const handlers = new Map<string, Array<(event: { preventDefault: () => void }) => void>>()
    const page = {
      isDestroyed: vi.fn(() => false),
      reloadIgnoringCache: vi.fn(),
      on: vi.fn((name: string, handler: (event: { preventDefault: () => void }) => void) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]) }),
      once: vi.fn((name: string, handler: (event: { preventDefault: () => void }) => void) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]) }),
      off: vi.fn((name: string, handler: (event: { preventDefault: () => void }) => void) => { handlers.set(name, (handlers.get(name) ?? []).filter((one) => one !== handler)) })
    }
    return { page, fire: (name: string, event = { preventDefault: vi.fn() }) => { for (const handler of [...(handlers.get(name) ?? [])]) handler(event); return event } }
  }

  it('reloads it past the cache and overrules a page that asks to stay, until the reload ends', () => {
    const { page, fire } = fakePage()
    reloadStalePage(page as never)
    expect(page.reloadIgnoringCache).toHaveBeenCalledOnce()
    expect(fire('will-prevent-unload').preventDefault).toHaveBeenCalledOnce()
    fire('did-stop-loading')
    expect(fire('will-prevent-unload').preventDefault).not.toHaveBeenCalled()
  })

  it('leaves a page that is gone alone', () => {
    const { page } = fakePage()
    page.isDestroyed.mockReturnValue(true)
    reloadStalePage(page as never)
    expect(page.reloadIgnoringCache).not.toHaveBeenCalled()
  })
})

describe('the page a visit is sending into the app', () => {
  it('is marked while the visit has it, and the pages that load again can leave it out', () => {
    const page = {}
    expect(isEnteringPage(page)).toBe(false)
    const release = enteringPage(page)
    expect(isEnteringPage(page)).toBe(true)
    release()
    expect(isEnteringPage(page)).toBe(false)
  })
})
