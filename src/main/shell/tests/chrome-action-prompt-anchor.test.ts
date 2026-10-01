import { describe, expect, it } from 'vitest'
import { promptAnchor, promptAnchorReport } from '../actions/prompt-anchor.js'
import { CHROME_ACTIONS, runChromeAction } from '../chrome-actions.js'
import type { WindowContext } from '../window-context.js'
import type { ShellWindow } from '../window-registry.js'

const windowOf = (): ShellWindow => ({}) as ShellWindow
const contextOf = (window: ShellWindow): WindowContext => ({ window, services: {} }) as unknown as WindowContext

describe('the prompt.anchor chrome action', () => {
  it('is registered', () => {
    expect(CHROME_ACTIONS['prompt.anchor']).toBe(promptAnchorReport)
  })

  it('has no anchor until the chrome reports one', () => {
    expect(promptAnchor(windowOf())).toBeUndefined()
  })

  it('keeps the last rectangle reported for each window separately', () => {
    const a = windowOf()
    const b = windowOf()
    runChromeAction('prompt.anchor', { x: 10, y: 20, width: 300, height: 30 }, contextOf(a))
    runChromeAction('prompt.anchor', { x: 11, y: 21, width: 301, height: 31 }, contextOf(b))
    runChromeAction('prompt.anchor', { x: 12, y: 22, width: 302, height: 32 }, contextOf(a))
    expect(promptAnchor(a)).toEqual({ x: 12, y: 22, width: 302, height: 32 })
    expect(promptAnchor(b)).toEqual({ x: 11, y: 21, width: 301, height: 31 })
  })

  it('keeps only the four numbers, not whatever else the payload carried', () => {
    const win = windowOf()
    runChromeAction('prompt.anchor', { x: 1, y: 2, width: 3, height: 4, extra: 'x' }, contextOf(win))
    expect(Object.keys(promptAnchor(win) ?? {}).sort()).toEqual(['height', 'width', 'x', 'y'])
  })

  it('ignores a payload that is not a finite, bounded rectangle', () => {
    const win = windowOf()
    const good = { x: 5, y: 5, width: 100, height: 20 }
    runChromeAction('prompt.anchor', good, contextOf(win))
    for (const bad of [undefined, null, 'rect', 7, {}, { ...good, x: '5' }, { ...good, width: Number.NaN }, { ...good, height: Infinity }, { ...good, width: 0 }, { ...good, y: 1e9 }, { ...good, width: 99999 }]) {
      runChromeAction('prompt.anchor', bad, contextOf(win))
    }
    expect(promptAnchor(win)).toEqual(good)
  })
})
