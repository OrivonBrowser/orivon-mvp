import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { ChromeContext, ChromeModule } from '../chrome/context.js'
import { runDecorators } from '../chrome/contain.js'
import { CHROME_MODULES, dispatchShellEvent, initModules, renderModules } from '../chrome/modules.js'

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

describe('a module that throws', () => {
  const tabState = {} as never
  const shellState = {} as never

  function broken (name: string, where: 'init' | 'render' | 'event'): ChromeModule & { ran: Mock } {
    const ran = vi.fn()
    const boom = (): never => { throw new Error(`${name} broke`) }
    return { name, ran, init: where === 'init' ? boom : ran, render: where === 'render' ? boom : ran, event: where === 'event' ? boom : ran } as ChromeModule & { ran: Mock }
  }

  it('is logged by name in init, render and event while the other modules carry on', () => {
    const complaint = vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const where of ['init', 'render', 'event'] as const) {
      const bad = broken('bad', where)
      const good = broken('good', where === 'init' ? 'render' : 'init')
      const modules = [bad, good]
      complaint.mockClear()
      if (where === 'init') initModules(ctx, modules)
      else if (where === 'render') renderModules(shellState, ctx, modules)
      else dispatchShellEvent({ type: 'module', module: 'bad', payload: 1 }, ctx, modules)
      expect(complaint).toHaveBeenCalledTimes(1)
      expect(String(complaint.mock.calls[0]?.[0])).toContain(`bad ${where}`)
      if (where !== 'event') expect(good.ran).toHaveBeenCalledTimes(1)
    }
    complaint.mockRestore()
  })

  it('is logged by name in a tab decorator, and the decorators after it still run', () => {
    const complaint = vi.spyOn(console, 'error').mockImplementation(() => {})
    const after = vi.fn()
    const badge = (): void => { throw new Error('badge broke') }
    runDecorators([badge, after], {} as HTMLElement, tabState, shellState, ctx)
    expect(after).toHaveBeenCalledTimes(1)
    expect(complaint).toHaveBeenCalledTimes(1)
    expect(String(complaint.mock.calls[0]?.[0])).toContain('badge')
    complaint.mockRestore()
  })
})
