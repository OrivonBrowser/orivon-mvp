import { afterEach, describe, expect, it, vi } from 'vitest'
import { onArmEnded } from '../shared/armed.js'
import { renderAction } from '../settings/rows.js'

class FakeButton {
  className = ''
  type = ''
  textContent = ''
  private readonly classes = new Set<string>()
  classList = { add: (name: string) => { this.classes.add(name) }, remove: (name: string) => { this.classes.delete(name) }, contains: (name: string) => this.classes.has(name) }
  private click: (() => void) | undefined
  addEventListener (_type: string, listener: () => void): void { this.click = listener }
  press (): void { this.click?.() }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('a two-click settings action', () => {
  it('says its armed window ended when it times out and when the second click runs it, so a held redraw runs', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('document', { createElement: () => new FakeButton() })
    const ended = vi.fn()
    const off = onArmEnded(ended)
    const run = vi.fn(async () => {})
    const button = renderAction({ type: 'action', label: 'Reset all settings', confirm: 'Click again to reset', run }, {} as never) as unknown as FakeButton

    button.press()
    expect(button.classList.contains('armed')).toBe(true)
    vi.advanceTimersByTime(4000)
    expect(button.classList.contains('armed')).toBe(false)
    expect(ended).toHaveBeenCalledTimes(1)

    button.press()
    button.press()
    expect(run).toHaveBeenCalledOnce()
    expect(ended).toHaveBeenCalledTimes(2)
    off()
  })
})
