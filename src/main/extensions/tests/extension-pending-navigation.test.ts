import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { createPendingNavigations } from '../extension-pending-navigation.js'

function setup (): { page: EventEmitter, isPending: () => boolean } {
  const page = new EventEmitter()
  const navigations = createPendingNavigations<EventEmitter>()
  navigations.watch(page)
  navigations.watch(page)
  return { page, isPending: () => navigations.isPending(page) }
}

const start = (page: EventEmitter, details: { isMainFrame: boolean, isSameDocument: boolean }): void => { page.emit('did-start-navigation', details) }

describe('pending navigations', () => {
  it('is not pending before any navigation starts', () => {
    expect(setup().isPending()).toBe(false)
  })

  it('is pending from the main frame\'s start of a navigation to another document until it commits', () => {
    const { page, isPending } = setup()
    start(page, { isMainFrame: true, isSameDocument: false })
    expect(isPending()).toBe(true)
    page.emit('did-navigate')
    expect(isPending()).toBe(false)
  })

  it('ignores a subframe and a same-document navigation', () => {
    const { page, isPending } = setup()
    start(page, { isMainFrame: false, isSameDocument: false })
    start(page, { isMainFrame: true, isSameDocument: true })
    expect(isPending()).toBe(false)
  })

  it('ends when the main frame fails to load, not when a subframe does', () => {
    const { page, isPending } = setup()
    start(page, { isMainFrame: true, isSameDocument: false })
    page.emit('did-fail-load', {}, -105, 'name not resolved', 'http://x/', false)
    expect(isPending()).toBe(true)
    page.emit('did-fail-load', {}, -105, 'name not resolved', 'http://x/', true)
    expect(isPending()).toBe(false)
  })

  it.each(['did-stop-loading', 'destroyed'])('ends on %s', (name) => {
    const { page, isPending } = setup()
    start(page, { isMainFrame: true, isSameDocument: false })
    page.emit(name)
    expect(isPending()).toBe(false)
  })

  it('is watched once however many times it is asked to be', () => {
    const { page } = setup()
    expect(page.listenerCount('did-start-navigation')).toBe(1)
  })
})
