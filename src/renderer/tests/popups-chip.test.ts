import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChromeContext, ToolbarButtonSpec } from '../chrome/context.js'
import { CHROME_MODULES } from '../chrome/modules.js'
import { countText, createPopupsChip, POPUPS_LABEL } from '../chrome/popups-chip.js'

vi.mock('../pages/shared/site-kind-icons.js', () => ({
  SITE_KIND_ICONS: {},
  blockedSiteKindIcon: (kind: string) => ({ kind, blocked: true })
}))

class FakeEl {
  hidden = false
  title = ''
  className = ''
  textContent = ''
  attrs = new Map<string, string>()
  children: unknown[] = []
  setAttribute (name: string, value: string): void { this.attrs.set(name, value) }
  append (...children: unknown[]): void { this.children.push(...children) }
}

afterEach(() => { vi.unstubAllGlobals() })

function mount () {
  vi.stubGlobal('document', { createElement: () => new FakeEl() })
  const act = vi.fn(() => Promise.resolve(undefined))
  const button = new FakeEl()
  let given: ToolbarButtonSpec | undefined
  const ctx = {
    shell: { act },
    anchorFor: () => ({ x: 1, y: 2, width: 3, height: 4 }),
    toolbarButton: (spec: ToolbarButtonSpec) => { given = spec; return button }
  } as unknown as ChromeContext
  const chip = createPopupsChip()
  chip.init(ctx)
  const badge = button.children.at(-1) as FakeEl
  const render = (popupsBlocked: number): void => { chip.render?.({ popupsBlocked } as never, ctx) }
  return { button, badge, act, render, spec: () => { if (given === undefined) throw new Error('no button'); return given } }
}

describe('countText', () => {
  it('says nothing for one, the number up to nine and "9+" above', () => {
    expect([0, 1, 2, 9, 10, 50].map(countText)).toEqual(['', '', '2', '9', '9+', '9+'])
  })
})

describe('the pop-up chip', () => {
  it('sits in the address slot after the permissions chip and before the password key', () => {
    expect(mount().spec()).toMatchObject({ id: 'popups-chip', slot: 'address', order: 12, label: POPUPS_LABEL })
    expect(mount().spec().icon()).toEqual({ kind: 'popups', blocked: true })
  })

  it('is registered with the chrome modules', () => {
    expect(CHROME_MODULES.map((module) => module.name)).toContain('popups-chip')
  })

  it('is hidden until a page had a pop-up blocked', () => {
    const { button, render } = mount()
    expect(button.hidden).toBe(true)
    render(1)
    expect(button.hidden).toBe(false)
    render(0)
    expect(button.hidden).toBe(true)
  })

  it('is named for the page and carries no badge for one block', () => {
    const { button, badge, render } = mount()
    render(1)
    expect(button.attrs.get('aria-label')).toBe(POPUPS_LABEL)
    expect(button.title).toBe(POPUPS_LABEL)
    expect(badge.hidden).toBe(true)
  })

  it('shows the count from two, capped at 9+, and says it in the name', () => {
    const { button, badge, render } = mount()
    render(3)
    expect(badge.textContent).toBe('3')
    expect(badge.hidden).toBe(false)
    expect(button.attrs.get('aria-label')).toBe(`${POPUPS_LABEL}: 3`)
    render(14)
    expect(badge.textContent).toBe('9+')
  })

  it('opens the bubble under itself', () => {
    const { spec, act, button } = mount()
    spec().onClick(button as unknown as HTMLButtonElement, {} as MouseEvent)
    expect(act).toHaveBeenCalledWith('overlay.toggle', { name: 'popups-blocked', anchor: { x: 1, y: 2, width: 3, height: 4 } })
  })
})
