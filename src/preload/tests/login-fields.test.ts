import { describe, expect, it } from 'vitest'
import { autocompleteTokens, canBeUsername, choosePassword, chooseUsername, fillScope, groupByScope, isRevealControl, isSignUp, isVisibleBox, newPasswordBoxes, pageIsSignUp, SCOPE_LEVELS, scopeLevel } from '../login-fields.js'
import type { FieldInfo } from '../login-fields.js'

const field = (over: Partial<FieldInfo> = {}): FieldInfo => ({ type: 'text', autocomplete: '', value: '', disabled: false, readOnly: false, visible: true, ...over })

describe('isVisibleBox', () => {
  it('needs a size and a style that does not hide it', () => {
    const shown = { display: 'block', visibility: 'visible' }
    expect(isVisibleBox({ width: 100, height: 20 }, shown)).toBe(true)
    expect(isVisibleBox({ width: 0, height: 20 }, shown)).toBe(false)
    expect(isVisibleBox({ width: 100, height: 0 }, shown)).toBe(false)
    expect(isVisibleBox({ width: 100, height: 20 }, { display: 'none', visibility: 'visible' })).toBe(false)
    expect(isVisibleBox({ width: 100, height: 20 }, { display: 'block', visibility: 'hidden' })).toBe(false)
    expect(isVisibleBox({ width: 100, height: 20 }, { display: 'block', visibility: 'collapse' })).toBe(false)
  })
})

describe('autocompleteTokens', () => {
  it('splits on whitespace and lower-cases', () => {
    expect(autocompleteTokens('Section-Blue  NEW-password')).toEqual(['section-blue', 'new-password'])
    expect(autocompleteTokens('')).toEqual([])
  })
})

describe('canBeUsername', () => {
  it('accepts text, email and tel boxes a person can type in', () => {
    for (const type of ['text', 'email', 'tel', '']) expect(canBeUsername(field({ type }))).toBe(true)
  })

  it('refuses hidden, disabled and read-only boxes, and types that are not text', () => {
    expect(canBeUsername(field({ visible: false }))).toBe(false)
    expect(canBeUsername(field({ disabled: true }))).toBe(false)
    expect(canBeUsername(field({ readOnly: true }))).toBe(false)
    for (const type of ['checkbox', 'radio', 'number', 'hidden', 'search', 'submit']) expect(canBeUsername(field({ type }))).toBe(false)
  })

  it('accepts whatever the page labels username or email, whatever the type', () => {
    expect(canBeUsername(field({ type: 'number', autocomplete: 'username' }))).toBe(true)
    expect(canBeUsername(field({ type: 'search', autocomplete: 'section-x email' }))).toBe(true)
  })
})

describe('chooseUsername', () => {
  it('picks the nearest text box before the password', () => {
    expect(chooseUsername([field(), field({ type: 'email' }), field({ type: 'checkbox' })])).toBe(1)
  })

  it('prefers a box the page calls username over a nearer one', () => {
    expect(chooseUsername([field({ autocomplete: 'username' }), field()])).toBe(0)
  })

  it('skips hidden boxes, and finds nothing when none qualifies', () => {
    expect(chooseUsername([field({ visible: false }), field({ type: 'checkbox' })])).toBe(-1)
    expect(chooseUsername([])).toBe(-1)
  })
})

describe('isSignUp', () => {
  it('is a form with a field the page calls new, or with two or more password fields', () => {
    expect(isSignUp([field({ type: 'password', autocomplete: 'new-password' })])).toBe(true)
    expect(isSignUp([field({ type: 'password' }), field({ type: 'password' })])).toBe(true)
    expect(isSignUp([field({ type: 'password', autocomplete: 'current-password' })])).toBe(false)
    expect(isSignUp([field({ type: 'password' })])).toBe(false)
    expect(isSignUp([])).toBe(false)
  })
})

describe('choosePassword', () => {
  const pw = (value: string, autocomplete = ''): FieldInfo => field({ type: 'password', value, autocomplete })

  it('takes the only field that has a value', () => {
    expect(choosePassword([pw('')])).toBe(-1)
    expect(choosePassword([pw('secret')])).toBe(0)
  })

  it('takes the field the page calls new over the others', () => {
    expect(choosePassword([pw('old', 'current-password'), pw('new', 'new-password'), pw('new')])).toBe(1)
  })

  it('takes the middle one of three, the new password of current, new, repeat', () => {
    expect(choosePassword([pw('old'), pw('new'), pw('new')])).toBe(1)
  })

  it('takes the first with a value in a two-field form', () => {
    expect(choosePassword([pw('a'), pw('a')])).toBe(0)
    expect(choosePassword([pw(''), pw('b')])).toBe(1)
  })
})

describe('isRevealControl', () => {
  it('knows the buttons that show or hide what was typed', () => {
    for (const label of ['Show password', 'hide', 'Reveal', 'Toggle visibility', 'eye icon']) expect(isRevealControl(label)).toBe(true)
  })

  it('does not take a sign-in button for one', () => {
    for (const label of ['Sign in', 'Log in', 'Continue', 'Submit', '']) expect(isRevealControl(label)).toBe(false)
  })
})

describe('pageIsSignUp', () => {
  it('follows the form the person touched, not the whole page', () => {
    expect(pageIsSignUp([false, true], 0)).toBe(false)
    expect(pageIsSignUp([false, true], 1)).toBe(true)
  })

  it('is a sign-up with no touch only when every form is one', () => {
    expect(pageIsSignUp([false, true], -1)).toBe(false)
    expect(pageIsSignUp([true, true], -1)).toBe(true)
    expect(pageIsSignUp([true], -1)).toBe(true)
    expect(pageIsSignUp([], -1)).toBe(false)
  })
})

describe('fillScope', () => {
  it('sends a new password to the first sign-up form and an account to the first other form', () => {
    expect(fillScope([false, true], true)).toBe(1)
    expect(fillScope([true, false], false)).toBe(1)
  })

  it('falls back to the first form, and to none when there is none', () => {
    expect(fillScope([false, false], true)).toBe(0)
    expect(fillScope([], true)).toBe(-1)
  })
})

describe('scopeLevel', () => {
  it('is the nearest ancestor that holds another box', () => {
    expect(scopeLevel([false, false, true, true])).toBe(2)
    expect(scopeLevel([true])).toBe(0)
  })

  it('falls back to the parent when no ancestor within the levels holds one', () => {
    expect(scopeLevel([])).toBe(0)
    expect(scopeLevel([false, false])).toBe(0)
    expect(scopeLevel([...new Array<boolean>(SCOPE_LEVELS).fill(false), true])).toBe(0)
  })
})

describe('groupByScope', () => {
  interface Node { name: string, parent: Node | null }
  const node = (name: string, parent: Node | null = null): Node => ({ name, parent })
  const holds = (outer: Node, inner: Node): boolean => {
    for (let at = inner.parent; at !== null; at = at.parent) if (at === outer) return true
    return false
  }

  it('puts boxes with the same scope together, in the order of their first box', () => {
    const page = node('page')
    const a = node('a', page)
    const b = node('b', page)
    expect(groupByScope([a, b, a], holds).map((group) => group.members)).toEqual([[0, 2], [1]])
  })

  it('puts a box and its confirmation together when one scope holds the other, and names the scope that holds the rest', () => {
    const page = node('page')
    const step = node('step', page)
    const inner = node('inner', step)
    const groups = groupByScope([inner, step], holds)
    expect(groups).toEqual([{ scope: step, members: [0, 1] }])
  })

  it('joins through a third scope, and keeps unrelated scopes apart', () => {
    const page = node('page')
    const left = node('left', page)
    const leftInner = node('leftInner', left)
    const rightInner = node('rightInner', node('right', page))
    const groups = groupByScope([leftInner, rightInner, left, page], holds)
    expect(groups.map((group) => group.members)).toEqual([[0, 1, 2, 3]])
    expect(groups[0]?.scope).toBe(page)
    const apart = groupByScope([leftInner, rightInner], holds)
    expect(apart.map((group) => group.members)).toEqual([[0], [1]])
  })

  it('is empty for no boxes', () => {
    expect(groupByScope([], holds)).toEqual([])
  })
})

describe('newPasswordBoxes', () => {
  const pw = (autocomplete = ''): FieldInfo => field({ type: 'password', autocomplete })

  it('is every box of a form of two, a password and its confirmation', () => {
    expect(newPasswordBoxes([pw(), pw()], 0)).toEqual([0, 1])
    expect(newPasswordBoxes([pw(), pw()], 1)).toEqual([0, 1])
  })

  it('reaches a confirmation the page does not call new, as most pages leave it', () => {
    expect(newPasswordBoxes([pw('new-password'), pw()], 0)).toEqual([0, 1])
    expect(newPasswordBoxes([pw('new-password'), pw('off')], 0)).toEqual([0, 1])
  })

  it('leaves a box the page calls current alone, unless the person is in it', () => {
    expect(newPasswordBoxes([pw('current-password'), pw('new-password'), pw('new-password')], 1)).toEqual([1, 2])
    expect(newPasswordBoxes([pw('current-password'), pw()], 1)).toEqual([1])
    expect(newPasswordBoxes([pw('current-password'), pw()], 0)).toEqual([0, 1])
  })

  it('is the last two of three when the first is not called new: current, new, repeat', () => {
    expect(newPasswordBoxes([pw(), pw(), pw()], 1)).toEqual([1, 2])
    expect(newPasswordBoxes([pw(), pw('new-password'), pw()], 1)).toEqual([1, 2])
    expect(newPasswordBoxes([pw('new-password'), pw(), pw()], 0)).toEqual([0, 1, 2])
  })

  it('is the one box of a form of one, and none when there is none', () => {
    expect(newPasswordBoxes([pw('new-password')], 0)).toEqual([0])
    expect(newPasswordBoxes([], -1)).toEqual([])
  })
})
