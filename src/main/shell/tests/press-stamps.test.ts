import { describe, expect, it } from 'vitest'
import { PRESS_MAX_AGE_MS, createPressStamps, isEchoOfClose, isPressButton } from '../press-stamps.js'

describe('createPressStamps', () => {
  it('stamps a press with its own clock and hands it to the click that follows, once', () => {
    let now = 1_000
    const stamps = createPressStamps(() => now)
    stamps.note('menu')
    now = 1_900
    expect(stamps.take('menu')).toBe(1_000)
    expect(stamps.take('menu')).toBeUndefined()
  })

  it('keeps one stamp per button', () => {
    let now = 5
    const stamps = createPressStamps(() => now)
    stamps.note('menu')
    now = 9
    stamps.note('web3')
    expect(stamps.take('main')).toBeUndefined()
    expect(stamps.take('web3')).toBe(9)
    expect(stamps.take('menu')).toBe(5)
  })

  it('drops a stamp older than a click in progress, so a key later is judged by the clock', () => {
    let now = 0
    const stamps = createPressStamps(() => now)
    stamps.note('permissions')
    now = PRESS_MAX_AGE_MS + 1
    expect(stamps.take('permissions')).toBeUndefined()
  })
})

describe('isEchoOfClose', () => {
  it('a press held for a long time is still the echo of the close it caused', () => {
    expect(isEchoOfClose(10_000, 10_008, 11_500)).toBe(true)
  })

  it('a close that came before the press is not its echo', () => {
    expect(isEchoOfClose(10_000, 10_400, 10_450)).toBe(false)
  })

  it('without a press, a close within 300 ms is the echo and an older one is not', () => {
    expect(isEchoOfClose(10_000, undefined, 10_299)).toBe(true)
    expect(isEchoOfClose(10_000, undefined, 10_300)).toBe(false)
  })
})

describe('isPressButton', () => {
  it('accepts the toolbar buttons and the overlays a button toggles, and nothing else', () => {
    for (const ok of ['menu', 'permissions', 'web3', 'main', 'downloads', 'extensions-menu', 'popups-blocked', 'site-prompt', 'tab-search']) expect(isPressButton(ok)).toBe(true)
    for (const bad of ['', 'Menu', 'constructor', '__proto__', 'find', 'downloads-peek', 1, null, undefined, {}, ['menu']]) expect(isPressButton(bad)).toBe(false)
  })
})
