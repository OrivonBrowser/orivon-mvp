import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { PageAccess } from '../page-access.js'

const tab = (): EventEmitter => new EventEmitter()
const SITE = 'https://chat.example'

describe('PageAccess', () => {
  it('lists what was decided on the page, in the order the kinds are listed', () => {
    const access = new PageAccess<EventEmitter>()
    const page = tab()
    access.note(page, SITE, 'location', 'blocked')
    access.note(page, SITE, 'camera', 'allowed')
    expect(access.entries(page)).toEqual([{ kind: 'camera', state: 'allowed' }, { kind: 'location', state: 'blocked' }])
    expect(access.originOf(page)).toBe(SITE)
  })

  it('has nothing for a tab that was never asked', () => {
    const access = new PageAccess<EventEmitter>()
    expect(access.entries(tab())).toEqual([])
    expect(access.originOf(tab())).toBeNull()
  })

  it('forgets everything when the tab loads another document, and tells its listeners', () => {
    const access = new PageAccess<EventEmitter>()
    const listener = vi.fn()
    access.onChange(listener)
    const page = tab()
    access.note(page, SITE, 'camera', 'blocked')
    access.dismiss(page, SITE, ['location'])
    expect(access.wasDismissed(page, SITE, 'location')).toBe(true)
    listener.mockClear()
    page.emit('did-navigate')
    expect(access.entries(page)).toEqual([])
    expect(access.wasDismissed(page, SITE, 'location')).toBe(false)
    expect(listener).toHaveBeenCalledWith(page)
  })

  it('does not notify for a navigation that clears nothing', () => {
    const access = new PageAccess<EventEmitter>()
    const listener = vi.fn()
    access.onChange(listener)
    const page = tab()
    access.dismiss(page, SITE, ['location'])
    page.emit('did-navigate')
    expect(listener).not.toHaveBeenCalled()
  })

  it('keeps a dismissed kind per origin: another site is asked again', () => {
    const access = new PageAccess<EventEmitter>()
    const page = tab()
    access.dismiss(page, SITE, ['camera'])
    expect(access.wasDismissed(page, SITE, 'camera')).toBe(true)
    expect(access.wasDismissed(page, 'https://other.example', 'camera')).toBe(false)
    expect(access.wasDismissed(page, SITE, 'microphone')).toBe(false)
  })

  it('starts over when the origin it describes is not the page\'s any more', () => {
    const access = new PageAccess<EventEmitter>()
    const page = tab()
    access.note(page, SITE, 'camera', 'allowed')
    access.note(page, 'https://other.example', 'location', 'blocked')
    expect(access.entries(page)).toEqual([{ kind: 'location', state: 'blocked' }])
    expect(access.originOf(page)).toBe('https://other.example')
  })

  it('an answer that replaces a dismissal lifts the dismissal; a repeated note notifies once', () => {
    const access = new PageAccess<EventEmitter>()
    const listener = vi.fn()
    access.onChange(listener)
    const page = tab()
    access.dismiss(page, SITE, ['camera'])
    access.note(page, SITE, 'camera', 'allowed')
    access.note(page, SITE, 'camera', 'allowed')
    expect(access.wasDismissed(page, SITE, 'camera')).toBe(false)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('counts the documents a tab loads', () => {
    const access = new PageAccess<EventEmitter>()
    const page = tab()
    const first = access.loads(page, SITE)
    page.emit('did-navigate')
    expect(access.loads(page, SITE)).toBe(first + 1)
  })

  it('keeps its tabs apart, and a failing listener does not stop the others', () => {
    const access = new PageAccess<EventEmitter>()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const good = vi.fn()
    access.onChange(() => { throw new Error('listener') })
    access.onChange(good)
    const one = tab()
    const two = tab()
    access.note(one, SITE, 'camera', 'allowed')
    expect(good).toHaveBeenCalledTimes(1)
    expect(access.entries(two)).toEqual([])
    error.mockRestore()
  })
})
