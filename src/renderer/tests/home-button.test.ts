import { describe, expect, it, vi } from 'vitest'
import type { ShellState } from '../../main/shell/tabs.js'
import { CHROME_MODULES } from '../chrome/modules.js'
import type { ChromeContext, ToolbarButtonSpec } from '../chrome/context.js'
import { createHomeButton } from '../chrome/home-button.js'

type Listener = (event: { button?: number, ctrlKey?: boolean, metaKey?: boolean, preventDefault: () => void }) => void

function setup (): { module: ReturnType<typeof createHomeButton>, ctx: ChromeContext, act: ReturnType<typeof vi.fn>, spec: () => ToolbarButtonSpec, button: { hidden: boolean, title: string }, fire: (type: string, init?: { button?: number, ctrlKey?: boolean, metaKey?: boolean }) => boolean } {
  const listeners = new Map<string, Listener>()
  const button = { hidden: false, title: '', addEventListener: (type: string, listener: Listener) => { listeners.set(type, listener) } }
  let given: ToolbarButtonSpec | undefined
  const act = vi.fn()
  const ctx = { shell: { act }, toolbarButton: (spec: ToolbarButtonSpec) => { given = spec; return button } } as unknown as ChromeContext
  const module = createHomeButton()
  module.init(ctx)
  const fire = (type: string, init: { button?: number, ctrlKey?: boolean, metaKey?: boolean } = {}): boolean => {
    let prevented = false
    listeners.get(type)?.({ ...init, preventDefault: () => { prevented = true } })
    return prevented
  }
  return { module, ctx, act, spec: () => { if (given === undefined) throw new Error('no button'); return given }, button, fire }
}

const state = (homeButton: boolean): ShellState => ({ homeButton }) as ShellState

describe('the Home button', () => {
  it('is one of the chrome modules', () => {
    expect(CHROME_MODULES.map((module) => module.name)).toContain('home')
  })

  it('sits in the nav slot right of Reload, named Home, hidden until the setting shows it', () => {
    const { spec, button } = setup()
    expect(spec()).toMatchObject({ id: 'home', slot: 'nav', order: 10, label: 'Home' })
    expect(button.title).toBe('Home (Alt+Home)')
    expect(button.hidden).toBe(true)
  })

  it('follows the setting as each state is pushed', () => {
    const { module, ctx, button } = setup()
    module.render?.(state(true), ctx)
    expect(button.hidden).toBe(false)
    module.render?.(state(false), ctx)
    expect(button.hidden).toBe(true)
  })

  it('loads the home page here on a click, and in a new tab on a Mod click', () => {
    const { spec, act, button } = setup()
    const click = (init: { ctrlKey?: boolean, metaKey?: boolean }): void => { spec().onClick(button as never, { ctrlKey: false, metaKey: false, ...init } as never) }
    click({})
    expect(act).toHaveBeenLastCalledWith('home.open', { newTab: false })
    click({ ctrlKey: true })
    expect(act).toHaveBeenLastCalledWith('home.open', { newTab: true })
    click({ metaKey: true })
    expect(act).toHaveBeenLastCalledWith('home.open', { newTab: true })
  })

  it('opens a new tab on a middle click, and on no other auxiliary button', () => {
    const { act, fire } = setup()
    expect(fire('auxclick', { button: 1 })).toBe(true)
    expect(act).toHaveBeenCalledWith('home.open', { newTab: true })
    act.mockClear()
    fire('auxclick', { button: 2 })
    expect(act).not.toHaveBeenCalled()
  })

  it('stops a middle press from starting autoscroll', () => {
    const { fire } = setup()
    expect(fire('mousedown', { button: 1 })).toBe(true)
    expect(fire('mousedown', { button: 0 })).toBe(false)
  })
})
