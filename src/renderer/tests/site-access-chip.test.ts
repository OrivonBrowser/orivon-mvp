import { describe, expect, it, vi } from 'vitest'
import type { ShellState } from '../../main/shell/tabs.js'
import { CHROME_MODULES } from '../chrome/modules.js'
import type { ChromeContext, ToolbarButtonSpec } from '../chrome/context.js'
import { chipFor, createSiteAccessChip } from '../chrome/site-access-chip.js'

vi.mock('../pages/shared/site-kind-icons.js', () => {
  const icon = (kind: string) => () => ({ kind })
  return {
    SITE_KIND_ICONS: new Proxy({}, { get: (_target, kind: string) => icon(kind) }),
    blockedSiteKindIcon: (kind: string) => ({ kind, blocked: true })
  }
})

const state = (siteAccess: ShellState['siteAccess']): ShellState => ({ siteAccess }) as unknown as ShellState
const camera = { kind: 'camera', state: 'allowed', label: 'Camera' } as const
const location = { kind: 'location', state: 'blocked', label: 'Location' } as const

function setup () {
  let given: ToolbarButtonSpec | undefined
  const act = vi.fn()
  const button = {
    hidden: false, title: '', className: '', painted: [] as unknown[],
    classes: new Set<string>(),
    classList: { toggle: (name: string, on: boolean) => { if (on) button.classes.add(name); else button.classes.delete(name) } },
    attrs: new Map<string, string>(),
    setAttribute: (name: string, value: string) => { button.attrs.set(name, value) },
    replaceChildren: (...children: unknown[]) => { button.painted = children }
  }
  const ctx = {
    shell: { act }, anchorFor: () => ({ x: 1, y: 2, width: 3, height: 4 }),
    toolbarButton: (spec: ToolbarButtonSpec) => { given = spec; return button }
  } as unknown as ChromeContext
  const module = createSiteAccessChip()
  module.init(ctx)
  return { module, ctx, act, button, spec: () => { if (given === undefined) throw new Error('no button'); return given } }
}

describe('chipFor', () => {
  it('is nothing for a page that was not asked', () => {
    expect(chipFor([])).toBeNull()
  })

  it('names the kind and what happened to it', () => {
    expect(chipFor([camera])).toEqual({ kind: 'camera', state: 'allowed', label: 'Camera allowed on this page' })
    expect(chipFor([location])).toEqual({ kind: 'location', state: 'blocked', label: 'Location blocked on this page' })
  })

  it('lets a block win over an allow, whatever the order', () => {
    expect(chipFor([camera, location])?.label).toBe('Location blocked on this page')
    expect(chipFor([location, camera])?.label).toBe('Location blocked on this page')
  })
})

describe('the site-access chip', () => {
  it('is one of the chrome modules', () => {
    expect(CHROME_MODULES.map((module) => module.name)).toContain('site-access')
  })

  it('sits first in the address slot, hidden until a page was asked', () => {
    const { spec, button } = setup()
    expect(spec()).toMatchObject({ id: 'site-access-chip', slot: 'address', order: 10 })
    expect(button.hidden).toBe(true)
  })

  it('shows what was blocked or allowed, in words, for the tooltip and the screen reader', () => {
    const { module, ctx, button } = setup()
    module.render?.(state([camera]), ctx)
    expect(button.hidden).toBe(false)
    expect(button.title).toBe('Camera allowed on this page')
    expect(button.attrs.get('aria-label')).toBe('Camera allowed on this page')
    expect([...button.classes]).toEqual(['allowed'])
    module.render?.(state([camera, location]), ctx)
    expect(button.attrs.get('aria-label')).toBe('Location blocked on this page')
    expect([...button.classes]).toEqual(['blocked'])
    expect(button.painted).toEqual([{ kind: 'location', blocked: true }])
  })

  it('hides again when the next page was not asked anything, and redraws its icon only when it changes', () => {
    const { module, ctx, button } = setup()
    module.render?.(state([camera]), ctx)
    const first = button.painted
    module.render?.(state([camera]), ctx)
    expect(button.painted).toBe(first)
    module.render?.(state([]), ctx)
    expect(button.hidden).toBe(true)
    module.render?.(state([camera]), ctx)
    expect(button.painted).not.toBe(first)
  })

  it('opens the review bubble under itself when clicked', () => {
    const { spec, act, button } = setup()
    spec().onClick(button as unknown as HTMLButtonElement, {} as MouseEvent)
    expect(act).toHaveBeenCalledWith('overlay.toggle', { name: 'site-prompt', anchor: { x: 1, y: 2, width: 3, height: 4 }, payload: { mode: 'review' } })
  })
})
