import { describe, expect, it } from 'vitest'
import { createArrival } from '../arrival.js'

function setup (): { arrival: ReturnType<typeof createArrival>, sent: string[], state: { arming: boolean } } {
  const sent: string[] = []
  const state = { arming: false }
  const arrival = createArrival({ send: (type) => { sent.push(type) }, isArming: () => state.arming, left: () => { sent.push('restore') } })
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

  it('sends nothing for a pointer or focus that rested on the button through the guard, until it arrives again', () => {
    const { arrival, sent, state } = setup()
    state.arming = true
    arrival.arrive()
    state.arming = false
    expect(sent).toEqual([])
    arrival.leave()
    arrival.arrive()
    expect(sent).toEqual(['enter'])
  })

  it('arrives anew after the panel moved under a pointer that was already on the button', () => {
    const { arrival, sent, state } = setup()
    arrival.arrive()
    state.arming = true
    arrival.restarted()
    arrival.arrive()
    state.arming = false
    expect(sent).toEqual(['enter'])
    arrival.arrive()
    expect(sent).toEqual(['enter', 'enter'])
  })
})
