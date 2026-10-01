import { describe, expect, it } from 'vitest'
import { listIntent, treeIntent } from '../keys.js'
import type { KeyFacts } from '../keys.js'

const facts = (key: string, extra: Partial<KeyFacts> = {}): KeyFacts => ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, inField: false, mac: false, ...extra })

describe('the list keys', () => {
  it('moves with the arrows, Home and End, and extends with Shift', () => {
    expect(listIntent(facts('ArrowDown'))).toEqual({ kind: 'move', to: 'down', extend: false })
    expect(listIntent(facts('ArrowUp', { shiftKey: true }))).toEqual({ kind: 'move', to: 'up', extend: true })
    expect(listIntent(facts('Home'))).toEqual({ kind: 'move', to: 'first', extend: false })
    expect(listIntent(facts('End'))).toEqual({ kind: 'move', to: 'last', extend: false })
  })

  it('selects all with the platform modifier only', () => {
    expect(listIntent(facts('a', { ctrlKey: true }))).toEqual({ kind: 'all' })
    expect(listIntent(facts('a', { metaKey: true }))).toBeNull()
    expect(listIntent(facts('a', { metaKey: true, mac: true }))).toEqual({ kind: 'all' })
  })

  it('opens with Enter, in the background with the modifier', () => {
    expect(listIntent(facts('Enter'))).toEqual({ kind: 'open', background: false })
    expect(listIntent(facts('Enter', { ctrlKey: true }))).toEqual({ kind: 'open', background: true })
  })

  it('goes up a folder with Backspace or Alt+Left, edits with F2, deletes with Delete', () => {
    expect(listIntent(facts('Backspace'))).toEqual({ kind: 'parent' })
    expect(listIntent(facts('ArrowLeft', { altKey: true }))).toEqual({ kind: 'parent' })
    expect(listIntent(facts('F2'))).toEqual({ kind: 'edit' })
    expect(listIntent(facts('Delete'))).toEqual({ kind: 'delete' })
    expect(listIntent(facts('Backspace', { metaKey: true, mac: true }))).toEqual({ kind: 'delete' })
  })

  it('nudges with Alt+Up and Alt+Down', () => {
    expect(listIntent(facts('ArrowUp', { altKey: true }))).toEqual({ kind: 'nudge', direction: 'up' })
    expect(listIntent(facts('ArrowDown', { altKey: true }))).toEqual({ kind: 'nudge', direction: 'down' })
    expect(listIntent(facts('ArrowDown', { altKey: true, shiftKey: true }))).toBeNull()
  })

  it('opens the menu by key, toggles with Space and focuses the search with a slash', () => {
    expect(listIntent(facts('ContextMenu'))).toEqual({ kind: 'menu' })
    expect(listIntent(facts('F10', { shiftKey: true }))).toEqual({ kind: 'menu' })
    expect(listIntent(facts(' '))).toEqual({ kind: 'toggle' })
    expect(listIntent(facts('/'))).toEqual({ kind: 'search' })
  })

  it('leaves a text field its own keys, except Escape', () => {
    expect(listIntent(facts('Backspace', { inField: true }))).toBeNull()
    expect(listIntent(facts('/', { inField: true }))).toBeNull()
    expect(listIntent(facts('Escape', { inField: true }))).toEqual({ kind: 'escape' })
  })

  it('ignores other chords', () => {
    expect(listIntent(facts('ArrowDown', { ctrlKey: true }))).toBeNull()
    expect(listIntent(facts('x'))).toBeNull()
  })
})

describe('the tree keys', () => {
  it('moves, expands, collapses and chooses', () => {
    expect(treeIntent('ArrowDown', false)).toEqual({ kind: 'move', to: 'down' })
    expect(treeIntent('End', false)).toEqual({ kind: 'move', to: 'last' })
    expect(treeIntent('ArrowRight', false)).toEqual({ kind: 'right' })
    expect(treeIntent('ArrowLeft', false)).toEqual({ kind: 'left' })
    expect(treeIntent('Enter', false)).toEqual({ kind: 'select' })
  })

  it('leaves modified keys to the browser', () => {
    expect(treeIntent('ArrowDown', true)).toBeNull()
    expect(treeIntent('x', false)).toBeNull()
  })
})
