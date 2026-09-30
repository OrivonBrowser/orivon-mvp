import { describe, expect, it, vi } from 'vitest'
import type { ShellState } from '../../main/shell/tabs.js'
import { CHROME_MODULES } from '../chrome/modules.js'
import type { ChromeContext, ToolbarButtonSpec } from '../chrome/context.js'
import { createPasswordKey, passwordKeyShown } from '../chrome/password-key.js'

const state = (logins: ShellState['logins']): ShellState => ({ logins }) as unknown as ShellState

function setup (): { module: ReturnType<typeof createPasswordKey>, ctx: ChromeContext, act: ReturnType<typeof vi.fn>, spec: () => ToolbarButtonSpec, button: { hidden: boolean, title: string, classList: { toggle: (name: string, on: boolean) => void }, attributes: Map<string, string>, setAttribute: (name: string, value: string) => void }, classes: Set<string> } {
  const classes = new Set<string>()
  const attributes = new Map<string, string>()
  const button = {
    hidden: false, title: '', attributes,
    setAttribute: (name: string, value: string) => { attributes.set(name, value) },
    classList: { toggle: (name: string, on: boolean) => { if (on) classes.add(name); else classes.delete(name) } }
  }
  let given: ToolbarButtonSpec | undefined
  const act = vi.fn()
  const ctx = { shell: { act }, anchorFor: () => ({ x: 1, y: 2, width: 3, height: 4 }), toolbarButton: (spec: ToolbarButtonSpec) => { given = spec; return button } } as unknown as ChromeContext
  const module = createPasswordKey()
  module.init(ctx)
  return { module, ctx, act, spec: () => { if (given === undefined) throw new Error('no button'); return given }, button, classes }
}

describe('the password button', () => {
  it('is one of the chrome modules', () => {
    expect(CHROME_MODULES.map((module) => module.name)).toContain('password-key')
  })

  it('sits in the address slot after the permission key, hidden until a page has something to offer', () => {
    const { spec, button } = setup()
    expect(spec()).toMatchObject({ id: 'password-key', slot: 'address', order: 20, label: 'Saved passwords for this site' })
    expect(button.hidden).toBe(true)
  })

  it('asks main for the chooser with its own rectangle', () => {
    const { spec, act } = setup()
    spec().onClick({} as HTMLButtonElement, {} as MouseEvent)
    expect(act).toHaveBeenCalledWith('passwords.key', { anchor: { x: 1, y: 2, width: 3, height: 4 } })
  })

  it('shows for saved logins, a sign-up form or a waiting offer, and hides otherwise', () => {
    expect(passwordKeyShown({ count: 0, offer: false, signUp: false })).toBe(false)
    expect(passwordKeyShown({ count: 2, offer: false, signUp: false })).toBe(true)
    expect(passwordKeyShown({ count: 0, offer: false, signUp: true })).toBe(true)
    expect(passwordKeyShown({ count: 0, offer: true, signUp: false })).toBe(true)
    const { module, ctx, button } = setup()
    module.render?.(state({ count: 1, offer: false, signUp: false }), ctx)
    expect(button.hidden).toBe(false)
    module.render?.(state({ count: 0, offer: false, signUp: false }), ctx)
    expect(button.hidden).toBe(true)
  })

  it('names itself for what it does now: the saved passwords, or the offer to save', () => {
    const { module, ctx, button, classes } = setup()
    module.render?.(state({ count: 1, offer: false, signUp: false }), ctx)
    expect(button.attributes.get('aria-label')).toBe('Saved passwords for this site')
    expect(classes.has('has-offer')).toBe(false)
    module.render?.(state({ count: 0, offer: true, signUp: false }), ctx)
    expect(button.attributes.get('aria-label')).toBe('Save this password')
    expect(button.title).toBe('Save this password')
    expect(classes.has('has-offer')).toBe(true)
  })
})
