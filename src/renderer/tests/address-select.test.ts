import { describe, expect, it } from 'vitest'
import { createAddressSelect } from '../chrome/address-select.js'

describe('createAddressSelect', () => {
  it('selects on a focus that arrives with no press, as Tab does', () => {
    const select = createAddressSelect()
    expect(select.focus()).toBe(true)
  })

  it('does not select when the window refocuses a field that never stopped being the active element', () => {
    const select = createAddressSelect()
    select.blur(true)
    expect(select.focus()).toBe(false)
  })

  it('selects on a focus after a real blur', () => {
    const select = createAddressSelect()
    select.blur(false)
    expect(select.focus()).toBe(true)
  })

  it('selects once the first press on an unfocused field is released, and not on the focus inside the press', () => {
    const select = createAddressSelect()
    select.pointerDown(false)
    expect(select.focus()).toBe(false)
    expect(select.pointerUp(false)).toBe(true)
  })

  it('selects on the first press after a window refocus, where the field is already the active element', () => {
    const select = createAddressSelect()
    select.blur(true)
    expect(select.focus()).toBe(false)
    select.pointerDown(true)
    expect(select.pointerUp(false)).toBe(true)
  })

  it('places a caret on a second press', () => {
    const select = createAddressSelect()
    select.pointerDown(false)
    select.focus()
    select.pointerUp(false)
    select.pointerDown(true)
    expect(select.pointerUp(false)).toBe(false)
  })

  it('keeps the range a first press dragged out', () => {
    const select = createAddressSelect()
    select.pointerDown(false)
    select.focus()
    expect(select.pointerUp(true)).toBe(false)
  })

  it('does not treat a press after typing as a first press', () => {
    const select = createAddressSelect()
    select.blur(true)
    select.focus()
    select.keyDown()
    select.pointerDown(true)
    expect(select.pointerUp(false)).toBe(false)
  })

  it('does not treat a press after an explicit select or an edit as a first press', () => {
    const select = createAddressSelect()
    select.blur(true)
    expect(select.focus()).toBe(false)
    select.entered()
    select.pointerDown(true)
    expect(select.pointerUp(false)).toBe(false)
  })

  it('forgets a press that ended on a drag, so the next focus is judged on its own', () => {
    const select = createAddressSelect()
    select.pointerDown(false)
    select.pointerUp(true)
    select.blur(false)
    expect(select.focus()).toBe(true)
  })
})
