import { describe, expect, it } from 'vitest'
import { intentFor } from '../keys.js'
import type { KeyFacts } from '../keys.js'

const facts = (key: string, extra: Partial<KeyFacts> = {}): KeyFacts => ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, inField: false, onRow: true, mac: false, ...extra })

describe('intentFor', () => {
  it('moves the focus with the arrows, Home and End, and extends with shift', () => {
    expect(intentFor(facts('ArrowDown'))).toEqual({ kind: 'move', to: 'down', extend: false })
    expect(intentFor(facts('ArrowUp', { shiftKey: true }))).toEqual({ kind: 'move', to: 'up', extend: true })
    expect(intentFor(facts('Home'))).toEqual({ kind: 'move', to: 'first', extend: false })
    expect(intentFor(facts('End', { shiftKey: true }))).toEqual({ kind: 'move', to: 'last', extend: true })
  })

  it('opens with Enter, in the background with Ctrl (Command on a Mac)', () => {
    expect(intentFor(facts('Enter'))).toEqual({ kind: 'open', disposition: 'tab' })
    expect(intentFor(facts('Enter', { ctrlKey: true }))).toEqual({ kind: 'open', disposition: 'background' })
    expect(intentFor(facts('Enter', { metaKey: true, mac: true }))).toEqual({ kind: 'open', disposition: 'background' })
    expect(intentFor(facts('Enter', { ctrlKey: true, mac: true }))).toEqual({ kind: 'open', disposition: 'tab' })
  })

  it('toggles with Space and deletes with Delete, and with Backspace only on a Mac', () => {
    expect(intentFor(facts(' '))).toEqual({ kind: 'toggle' })
    expect(intentFor(facts('Delete'))).toEqual({ kind: 'delete' })
    expect(intentFor(facts('Backspace'))).toBeNull()
    expect(intentFor(facts('Backspace', { mac: true }))).toEqual({ kind: 'delete' })
  })

  it('selects everything with the platform\'s Select All, from anywhere but a text field', () => {
    expect(intentFor(facts('a', { ctrlKey: true, onRow: false }))).toEqual({ kind: 'all' })
    expect(intentFor(facts('a', { metaKey: true, mac: true }))).toEqual({ kind: 'all' })
    expect(intentFor(facts('a', { ctrlKey: true, mac: true }))).toBeNull()
    expect(intentFor(facts('a', { ctrlKey: true, inField: true }))).toBeNull()
  })

  it('focuses the search with a slash outside a text field, and leaves a slash typed there alone', () => {
    expect(intentFor(facts('/', { onRow: false }))).toEqual({ kind: 'search' })
    expect(intentFor(facts('/', { inField: true }))).toBeNull()
  })

  it('reports Escape everywhere, for the page to decide what it clears', () => {
    expect(intentFor(facts('Escape', { inField: true, onRow: false }))).toEqual({ kind: 'escape' })
  })

  it('leaves a row\'s keys alone when the focus is on a button inside it, or a chord is not ours', () => {
    for (const key of ['ArrowDown', ' ', 'Delete', 'Enter']) expect(intentFor(facts(key, { onRow: false }))).toBeNull()
    expect(intentFor(facts('ArrowDown', { ctrlKey: true }))).toBeNull()
    expect(intentFor(facts('ArrowDown', { altKey: true }))).toBeNull()
    expect(intentFor(facts('x'))).toBeNull()
  })
})
