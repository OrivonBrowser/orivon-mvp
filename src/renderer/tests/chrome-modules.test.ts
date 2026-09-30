import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { ChromeContext, ChromeModule } from '../chrome/context.js'
import { CHROME_MODULES, dispatchShellEvent } from '../chrome/modules.js'

const ctx = {} as ChromeContext

function fake (name: string): ChromeModule & { event: Mock<(payload: unknown, ctx: ChromeContext) => void> } {
  return { name, init: vi.fn(), event: vi.fn<(payload: unknown, ctx: ChromeContext) => void>() }
}

describe('CHROME_MODULES', () => {
  it('names each module once, and every module can be initialised', () => {
    const names = CHROME_MODULES.map((module) => module.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toEqual(expect.arrayContaining(['tab-strip', 'navigation']))
    for (const module of CHROME_MODULES) expect(typeof module.init).toBe('function')
  })
})

describe('dispatchShellEvent', () => {
  it('gives a module event to the module it names, and to no other', () => {
    const tabStrip = fake('tab-strip')
    const navigation = fake('navigation')
    const downloads = fake('downloads')

    dispatchShellEvent({ type: 'module', module: 'downloads', payload: { n: 1 } }, ctx, [tabStrip, navigation, downloads])

    expect(downloads.event).toHaveBeenCalledWith({ n: 1 }, ctx)
    expect(tabStrip.event).not.toHaveBeenCalled()
    expect(navigation.event).not.toHaveBeenCalled()
  })

  it('routes the address focus to navigation and the drop mark to the tab strip, event unchanged', () => {
    const tabStrip = fake('tab-strip')
    const navigation = fake('navigation')
    const modules = [tabStrip, navigation]

    dispatchShellEvent({ type: 'focusAddress' }, ctx, modules)
    dispatchShellEvent({ type: 'dragMark', index: 3 }, ctx, modules)
    dispatchShellEvent({ type: 'dragMarkClear' }, ctx, modules)

    expect(navigation.event.mock.calls).toEqual([[{ type: 'focusAddress' }, ctx]])
    expect(tabStrip.event.mock.calls).toEqual([[{ type: 'dragMark', index: 3 }, ctx], [{ type: 'dragMarkClear' }, ctx]])
  })

  it('ignores an event for a module that is not registered or takes no events', () => {
    const quiet: ChromeModule = { name: 'quiet', init: vi.fn() }

    expect(() => { dispatchShellEvent({ type: 'module', module: 'quiet', payload: 1 }, ctx, [quiet]) }).not.toThrow()
    expect(() => { dispatchShellEvent({ type: 'module', module: 'ghost', payload: 1 }, ctx, [quiet]) }).not.toThrow()
  })
})
