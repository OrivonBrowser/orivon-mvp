import { describe, expect, it, vi } from 'vitest'
import type { ShellState } from '../../main/shell/tabs.js'
import { CHROME_MODULES } from '../chrome/modules.js'
import type { ChromeContext, ToolbarButtonSpec } from '../chrome/context.js'
import { createExtensionsButton } from '../chrome/extensions-button.js'

interface Fake { hidden: boolean, attributes: Record<string, string>, setAttribute: (name: string, value: string) => void }

function setup (menuRect: { x: number, y: number, width: number, height: number } | null = { x: 900, y: 8, width: 32, height: 32 }): { module: ReturnType<typeof createExtensionsButton>, ctx: ChromeContext, act: ReturnType<typeof vi.fn>, spec: () => ToolbarButtonSpec, button: Fake, anchored: Element[] } {
  const button: Fake = { hidden: false, attributes: {}, setAttribute (name, value) { this.attributes[name] = value } }
  let given: ToolbarButtonSpec | undefined
  const act = vi.fn()
  const anchored: Element[] = []
  vi.stubGlobal('document', { getElementById: (id: string) => (id === 'menu' && menuRect !== null ? { id } : null) })
  const ctx = {
    shell: { act },
    anchorFor: (el: Element) => { anchored.push(el); return el === (button as unknown) ? { x: 700, y: 8, width: 32, height: 32 } : (menuRect ?? { x: 0, y: 0, width: 0, height: 0 }) },
    toolbarButton: (spec: ToolbarButtonSpec) => { given = spec; return button }
  } as unknown as ChromeContext
  const module = createExtensionsButton()
  module.init(ctx)
  return { module, ctx, act, spec: () => { if (given === undefined) throw new Error('no button'); return given }, button, anchored }
}

const state = (shown: boolean): ShellState => ({ extensions: { enabled: shown ? 2 : 0, shown } }) as unknown as ShellState

describe('the Extensions button', () => {
  it('is one of the chrome modules', () => {
    expect(CHROME_MODULES.map((module) => module.name)).toContain('extensions-button')
  })

  it('sits in the cluster slot before Downloads, named Extensions, hidden until shown, and says it opens a menu', () => {
    const { spec, button } = setup()
    expect(spec()).toMatchObject({ id: 'extensions-menu-btn', slot: 'cluster', order: 5, label: 'Extensions' })
    expect(button.hidden).toBe(true)
    expect(button.attributes).toMatchObject({ 'aria-haspopup': 'menu', 'aria-expanded': 'false' })
  })

  it('follows the state main pushes', () => {
    const { module, ctx, button } = setup()
    module.render?.(state(true), ctx)
    expect(button.hidden).toBe(false)
    module.render?.(state(false), ctx)
    expect(button.hidden).toBe(true)
  })

  it('opens the menu under itself on a click, passing the same place for the popup an extension opens', () => {
    const { spec, act, button } = setup()
    button.hidden = false
    spec().onClick(button as never, {} as never)
    const anchor = { x: 700, y: 8, width: 32, height: 32 }
    expect(act).toHaveBeenCalledWith('overlay.toggle', { name: 'extensions-menu', anchor, payload: { anchor } })
  })

  it('hangs from the main menu\'s button when asked to open while it is hidden', () => {
    const { module, ctx, act, button } = setup()
    button.hidden = true
    module.event?.({ type: 'open' }, ctx)
    const anchor = { x: 900, y: 8, width: 32, height: 32 }
    expect(act).toHaveBeenCalledWith('overlay.toggle', { name: 'extensions-menu', anchor, payload: { anchor } })
  })

  it('opens nowhere when there is nothing to hang from', () => {
    const { module, ctx, act, button } = setup(null)
    button.hidden = true
    module.event?.({ type: 'open' }, ctx)
    expect(act).not.toHaveBeenCalled()
  })

  it('follows main telling it the menu opened or closed, and ignores anything else', () => {
    const { module, ctx, button } = setup()
    module.event?.({ type: 'expanded', value: true }, ctx)
    expect(button.attributes['aria-expanded']).toBe('true')
    module.event?.({ type: 'expanded', value: false }, ctx)
    expect(button.attributes['aria-expanded']).toBe('false')
    module.event?.({ type: 'expanded', value: 'yes' }, ctx)
    module.event?.({ type: 'unknown' }, ctx)
    module.event?.(null, ctx)
    module.event?.('open', ctx)
    expect(button.attributes['aria-expanded']).toBe('false')
  })
})
