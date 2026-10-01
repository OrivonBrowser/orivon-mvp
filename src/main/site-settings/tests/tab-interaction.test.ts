import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { DELIBERATE_INPUT, TabInteraction } from '../tab-interaction.js'
import type { InputTab } from '../tab-interaction.js'

class FakeTab extends EventEmitter implements InputTab {
  input (type: string): void { this.emit('input-event', {}, { type }) }
}

function rig () {
  let now = 1000
  const interaction = new TabInteraction<FakeTab>(() => now)
  const tab = new FakeTab()
  interaction.watch(tab)
  return { interaction, tab, advance: (ms: number) => { now += ms } }
}

describe('TabInteraction', () => {
  it('knows nothing about a tab it was never told of', () => {
    expect(new TabInteraction<FakeTab>().read(new FakeTab())).toEqual({ at: null, consumed: false })
  })

  it.each([...DELIBERATE_INPUT])('records %s as the person\'s own input', (type) => {
    const { interaction, tab } = rig()
    tab.input(type)
    expect(interaction.read(tab)).toEqual({ at: 1000, consumed: false })
  })

  it.each(['mouseMove', 'mouseUp', 'mouseWheel', 'keyUp', 'char', 'gestureScrollUpdate'])('does not count %s', (type) => {
    const { interaction, tab } = rig()
    tab.input(type)
    expect(interaction.read(tab).at).toBeNull()
  })

  it('spends an input once, and a new one is fresh again', () => {
    const { interaction, tab, advance } = rig()
    tab.input('mouseDown')
    interaction.consume(tab)
    expect(interaction.read(tab)).toEqual({ at: 1000, consumed: true })
    advance(50)
    tab.input('rawKeyDown')
    expect(interaction.read(tab)).toEqual({ at: 1050, consumed: false })
  })

  it('listens once however many times it is asked to watch', () => {
    const { interaction, tab } = rig()
    interaction.watch(tab)
    interaction.watch(tab)
    expect(tab.listenerCount('input-event')).toBe(1)
  })

  it('keeps each tab apart', () => {
    const { interaction, tab } = rig()
    const other = new FakeTab()
    interaction.watch(other)
    tab.input('mouseDown')
    expect(interaction.read(other).at).toBeNull()
  })

  it('has nothing to consume for a tab it does not watch', () => {
    const interaction = new TabInteraction<FakeTab>()
    expect(() => { interaction.consume(new FakeTab()) }).not.toThrow()
  })
})
