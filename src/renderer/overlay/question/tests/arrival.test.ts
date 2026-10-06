import { describe, expect, it } from 'vitest'
import { createArrival } from '../arrival.js'

function setup (): { arrival: ReturnType<typeof createArrival>, sent: string[], state: { arming: boolean, over: boolean } } {
  const sent: string[] = []
  const state = { arming: false, over: false }
  const arrival = createArrival({ send: (type) => { sent.push(type) }, isArming: () => state.arming, isOver: () => state.over, left: () => { sent.push('restore') } })
  return { arrival, sent, state }
}

describe('createArrival', () => {
  it('tells main once when the pointer arrives outside the guard, and again after it leaves', () => {
    const { arrival, sent } = setup()
    arrival.arrive(); arrival.arrive()
    arrival.leave(); arrival.leave()
    arrival.arrive()
    expect(sent).toEqual(['enter', 'restore', 'leave', 'enter'])
  })

  it('sends nothing while the guard runs, so a pointer that moved in during it can still arm the button', () => {
    const { arrival, sent, state } = setup()
    state.arming = true
    arrival.arrive(); arrival.arrive()
    state.arming = false
    arrival.arrive()
    expect(sent).toEqual(['enter'])
  })

  it('sends the arrival when the guard ends under a pointer or focus that stayed on the button', () => {
    const { arrival, sent, state } = setup()
    state.arming = true
    state.over = true
    arrival.arrive()
    state.arming = false
    arrival.guardEnded()
    expect(sent).toEqual(['enter'])
  })

  it('sends nothing when the guard ends and the button is not under the pointer or focus', () => {
    const { arrival, sent } = setup()
    arrival.guardEnded()
    expect(sent).toEqual([])
  })

  it('arrives again after the panel moved under a pointer that was already on the button', () => {
    const { arrival, sent, state } = setup()
    state.over = true
    arrival.arrive()
    state.arming = true
    arrival.restarted()
    state.arming = false
    arrival.guardEnded()
    expect(sent).toEqual(['enter', 'enter'])
  })
})
