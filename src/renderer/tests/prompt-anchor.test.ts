import { describe, expect, it, vi } from 'vitest'
import type { ShellState } from '../../main/shell/tabs.js'
import type { ChromeContext, OverlayAnchor } from '../chrome/context.js'
import { CHROME_MODULES } from '../chrome/modules.js'
import { createPromptAnchor } from '../chrome/prompt-anchor.js'

function setup (): { ctx: ChromeContext, act: ReturnType<typeof vi.fn>, move: (rect: OverlayAnchor) => void, module: ReturnType<typeof createPromptAnchor> } {
  let rect: OverlayAnchor = { x: 100, y: 10, width: 600, height: 32 }
  const act = vi.fn()
  const ctx = { shell: { act }, anchorFor: () => rect } as unknown as ChromeContext
  return { ctx, act, move: (next) => { rect = next }, module: createPromptAnchor(() => ({}) as Element) }
}

describe('the prompt anchor module', () => {
  it('is one of the chrome modules', () => {
    expect(CHROME_MODULES.map((module) => module.name)).toContain('prompt-anchor')
  })

  it('reports the address pill once at start', () => {
    const { module, ctx, act } = setup()
    module.init(ctx)
    expect(act).toHaveBeenCalledExactlyOnceWith('prompt.anchor', { x: 100, y: 10, width: 600, height: 32 })
  })

  it('reports again only when the rectangle changed', () => {
    const { module, ctx, act, move } = setup()
    module.init(ctx)
    module.render?.({} as ShellState, ctx)
    expect(act).toHaveBeenCalledTimes(1)
    move({ x: 120, y: 10, width: 580, height: 32 })
    module.render?.({} as ShellState, ctx)
    expect(act).toHaveBeenCalledTimes(2)
    expect(act).toHaveBeenLastCalledWith('prompt.anchor', { x: 120, y: 10, width: 580, height: 32 })
  })

  it('says nothing while the pill has no size, as when the toolbar is hidden', () => {
    const { module, ctx, act, move } = setup()
    move({ x: 0, y: 0, width: 0, height: 0 })
    module.init(ctx)
    expect(act).not.toHaveBeenCalled()
  })

  it('does nothing when there is no address pill', () => {
    const act = vi.fn()
    const module = createPromptAnchor(() => null)
    const ctx = { shell: { act }, anchorFor: () => ({ x: 1, y: 1, width: 1, height: 1 }) } as unknown as ChromeContext
    module.init(ctx)
    module.render?.({} as ShellState, ctx)
    expect(act).not.toHaveBeenCalled()
  })
})
