import { describe, expect, it } from 'vitest'
import { guardMiddleClickPaste, isEditableTarget } from '../pages/shared/middle-click-guard.js'
import type { MouseUpEventLike } from '../pages/shared/middle-click-guard.js'

function install (): (event: Partial<MouseUpEventLike> & { target: unknown }) => boolean {
  let listener: ((event: MouseUpEventLike) => void) | undefined
  let capture: boolean | undefined
  guardMiddleClickPaste({ addEventListener: (type, fn, useCapture) => { expect(type).toBe('mouseup'); listener = fn; capture = useCapture } })
  expect(capture).toBe(true)
  return (event) => {
    let prevented = false
    listener?.({ button: 1, preventDefault: () => { prevented = true }, ...event })
    return prevented
  }
}

describe('guardMiddleClickPaste', () => {
  it('cancels the middle release over a tab, so the focused address bar is not pasted into', () => {
    expect(install()({ target: { tagName: 'DIV', isContentEditable: false } })).toBe(true)
  })

  it('leaves the middle release over a field alone, so a paste into it still works', () => {
    const release = install()
    expect(release({ target: { tagName: 'INPUT', isContentEditable: false } })).toBe(false)
    expect(release({ target: { tagName: 'TEXTAREA', isContentEditable: false } })).toBe(false)
    expect(release({ target: { tagName: 'DIV', isContentEditable: true } })).toBe(false)
  })

  it('ignores the other buttons', () => {
    const release = install()
    expect(release({ button: 0, target: { tagName: 'DIV' } })).toBe(false)
    expect(release({ button: 2, target: { tagName: 'DIV' } })).toBe(false)
  })

  it('treats a missing target as not editable', () => {
    expect(isEditableTarget(null)).toBe(false)
    expect(isEditableTarget(undefined)).toBe(false)
  })
})
