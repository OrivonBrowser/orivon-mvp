import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { watchArrival } from '../popover-arrival.js'

function page (): EventEmitter {
  return new EventEmitter()
}

describe('watching a page that is still arriving', () => {
  it('reads the page taking the keyboard as its first page committing, when nothing was pressed in it', () => {
    const tab = page()
    const hold = watchArrival(tab as never, vi.fn())
    expect(hold.arrivedWithKeyboard()).toBe(false)
    tab.emit('focus')
    expect(hold.arrivedWithKeyboard()).toBe(true)
  })

  it('reads a press in the page before it took the keyboard as the person clicking away', () => {
    const tab = page()
    const hold = watchArrival(tab as never, vi.fn())
    tab.emit('input-event', {}, { type: 'mouseDown' })
    tab.emit('focus')
    expect(hold.arrivedWithKeyboard()).toBe(false)
  })

  it('does not take a key or a move of the pointer in the page for a press', () => {
    const tab = page()
    const hold = watchArrival(tab as never, vi.fn())
    tab.emit('input-event', {}, { type: 'mouseMove' })
    tab.emit('input-event', {}, { type: 'keyDown' })
    tab.emit('focus')
    expect(hold.arrivedWithKeyboard()).toBe(true)
  })

  it('ends once, when the page has loaded, is destroyed, or the hold is ended, and listens to nothing after', () => {
    for (const ending of ['did-stop-loading', 'destroyed', 'manual']) {
      const tab = page()
      const onEnd = vi.fn()
      const hold = watchArrival(tab as never, onEnd)
      if (ending === 'manual') hold.end()
      else tab.emit(ending)
      hold.end()
      tab.emit('did-stop-loading')
      expect(onEnd, ending).toHaveBeenCalledTimes(1)
      expect(tab.listenerCount('focus'), ending).toBe(0)
      expect(tab.listenerCount('input-event'), ending).toBe(0)
      tab.emit('focus')
      expect(hold.arrivedWithKeyboard(), ending).toBe(false)
    }
  })
})
