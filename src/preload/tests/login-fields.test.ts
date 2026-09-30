import { describe, expect, it } from 'vitest'
import { autocompleteTokens, canBeUsername, choosePassword, chooseUsername, isRevealControl, isSignUp, isVisibleBox } from '../login-fields.js'
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
