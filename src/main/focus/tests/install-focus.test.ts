import { describe, expect, it, vi } from 'vitest'
import type { ShellServices } from '../../shell/shell-services.js'

const applyCaret = vi.fn()
vi.mock('../caret-runner.js', () => ({ applyCaret: (...args: unknown[]) => { applyCaret(...args) } }))

const { installFocus } = await import('../install-focus.js')

describe('installFocus', () => {
  it('puts the caret setting on every tab when it changes, and for no other setting', () => {
    let listener: ((change: { key: string }) => void) | undefined
    const services = { settings: { onChange: (fn: typeof listener) => { listener = fn } } } as unknown as ShellServices
    installFocus.install({} as never, services, {} as never, {} as never)
    listener?.({ key: 'accessibility.caretAsk' })
    expect(applyCaret).not.toHaveBeenCalled()
    listener?.({ key: 'accessibility.caretBrowsing' })
    expect(applyCaret).toHaveBeenCalledWith(services)
  })
})
