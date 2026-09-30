import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { App } from 'electron'
import { createPageTracker } from '../page-tracker.js'
import { watchPages } from '../watch-pages.js'

const APP_ORIGIN = 'https://app.example'
const OTHER_ORIGIN = 'https://other.example'

/** A real EventEmitter -- watchPages attaches its own listeners to it, as `app.on('web-contents-created', ...)` would.
 * Cast rather than typed as `Pick<App, 'on'>` directly: Electron's own `on` is one huge overload
 * set (one signature per named event, `this: App` each), which a plain EventEmitter's `on` can
 * never structurally satisfy even though every call this file makes is one of the real overloads. */
function fakeApp (): EventEmitter {
  const emitter = new EventEmitter()
  emitter.setMaxListeners(0)
  return emitter
}

function asApp (emitter: EventEmitter): Pick<App, 'on'> {
  return emitter as unknown as Pick<App, 'on'>
}

/** A 'window' WebContents: a real EventEmitter with `getType()`, since watchPages filters on it before wiring anything. */
function fakeWindowContents (): EventEmitter & { getType: () => string } {
  return Object.assign(new EventEmitter(), { getType: () => 'window' })
}

function fakeNonWindowContents (): EventEmitter & { getType: () => string } {
  return Object.assign(new EventEmitter(), { getType: () => 'offscreen' })
}

describe('watchPages', () => {
  it('counts two pages of the same origin, and only the last close reaches zero', () => {
    const app = fakeApp()
    const tracker = createPageTracker()
    watchPages(asApp(app), tracker)

    const pageA = fakeWindowContents()
    const pageB = fakeWindowContents()
    app.emit('web-contents-created', {}, pageA)
    app.emit('web-contents-created', {}, pageB)

    pageA.emit('did-navigate', {}, `${APP_ORIGIN}/a`)
    pageB.emit('did-navigate', {}, `${APP_ORIGIN}/b`)
    expect(tracker.countAt(APP_ORIGIN)).toBe(2)

    const onEmpty = vi.fn()
    tracker.onceEmpty(APP_ORIGIN, onEmpty)

    pageA.emit('destroyed')
    expect(onEmpty).not.toHaveBeenCalled()
    expect(tracker.countAt(APP_ORIGIN)).toBe(1)

    pageB.emit('destroyed')
    expect(onEmpty).toHaveBeenCalledOnce()
    expect(tracker.countAt(APP_ORIGIN)).toBe(0)
  })

  it('a reload of the only page passes through zero before landing back at one', () => {
    const app = fakeApp()
    const tracker = createPageTracker()
    watchPages(asApp(app), tracker)

    const page = fakeWindowContents()
    app.emit('web-contents-created', {}, page)
    page.emit('did-navigate', {}, `${APP_ORIGIN}/a`)

    const onEmpty = vi.fn()
    tracker.onceEmpty(APP_ORIGIN, onEmpty)

    // did-navigate fires again for a reload of the SAME origin/URL.
    page.emit('did-navigate', {}, `${APP_ORIGIN}/a`)

    expect(onEmpty).toHaveBeenCalledOnce()
    expect(tracker.countAt(APP_ORIGIN)).toBe(1)
  })

  it('navigating away from the app closes the app origin and opens the new one', () => {
    const app = fakeApp()
    const tracker = createPageTracker()
    watchPages(asApp(app), tracker)

    const page = fakeWindowContents()
    app.emit('web-contents-created', {}, page)
    page.emit('did-navigate', {}, `${APP_ORIGIN}/a`)

    const onEmpty = vi.fn()
    tracker.onceEmpty(APP_ORIGIN, onEmpty)

    page.emit('did-navigate', {}, `${OTHER_ORIGIN}/x`)

    expect(onEmpty).toHaveBeenCalledOnce()
    expect(tracker.countAt(APP_ORIGIN)).toBe(0)
    expect(tracker.countAt(OTHER_ORIGIN)).toBe(1)
  })

  it('a crashed page (render-process-gone) closes its origin the same as destroyed', () => {
    const app = fakeApp()
    const tracker = createPageTracker()
    watchPages(asApp(app), tracker)

    const page = fakeWindowContents()
    app.emit('web-contents-created', {}, page)
    page.emit('did-navigate', {}, `${APP_ORIGIN}/a`)

    const onEmpty = vi.fn()
    tracker.onceEmpty(APP_ORIGIN, onEmpty)

    page.emit('render-process-gone')

    expect(onEmpty).toHaveBeenCalledOnce()
    expect(tracker.countAt(APP_ORIGIN)).toBe(0)
  })

  it('destroyed after render-process-gone for the same contents does not double-close', () => {
    const app = fakeApp()
    const tracker = createPageTracker()
    watchPages(asApp(app), tracker)

    const page = fakeWindowContents()
    app.emit('web-contents-created', {}, page)
    page.emit('did-navigate', {}, `${APP_ORIGIN}/a`)

    const onEmpty = vi.fn()
    tracker.onceEmpty(APP_ORIGIN, onEmpty)

    page.emit('render-process-gone')
    page.emit('destroyed')

    expect(onEmpty).toHaveBeenCalledOnce()
  })

  it('ignores a non-window WebContents entirely (the host itself, getType() === "offscreen")', () => {
    const app = fakeApp()
    const tracker = createPageTracker()
    watchPages(asApp(app), tracker)

    const host = fakeNonWindowContents()
    app.emit('web-contents-created', {}, host)
    host.emit('did-navigate', {}, `${APP_ORIGIN}/.well-known/orivon/child-host`)

    expect(tracker.countAt(APP_ORIGIN)).toBe(0)
  })
})
