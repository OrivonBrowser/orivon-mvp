import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ShellState } from '../../main/shell/tabs.js'
import type { ChromeContext, ToolbarButtonSpec } from '../chrome/context.js'
import { CHROME_MODULES } from '../chrome/modules.js'
import { createSidePanelButton } from '../chrome/side-panel-button.js'

vi.mock('../pages/shared/icons.js', () => ({ panelLeftIcon: () => 'left', panelRightIcon: () => 'right' }))

function setup (width = 1200): { module: ReturnType<typeof createSidePanelButton>, ctx: ChromeContext, spec: () => ToolbarButtonSpec, button: Record<string, unknown>, runCommand: ReturnType<typeof vi.fn>, resize: () => void } {
  const attributes = new Map<string, string>()
  const classes = new Set<string>()
  const button: Record<string, unknown> = {
    disabled: false,
    title: '',
    children: [] as unknown[],
    setAttribute: (name: string, value: string) => { attributes.set(name, value) },
    replaceChildren: (...nodes: unknown[]) => { button['children'] = nodes },
    classList: { toggle: (name: string, on: boolean) => { if (on) classes.add(name); else classes.delete(name) } },
    attributes,
    classes
  }
  let given: ToolbarButtonSpec | undefined
  const runCommand = vi.fn()
  const listeners = new Map<string, () => void>()
  vi.stubGlobal('window', { innerWidth: width, addEventListener: (type: string, listener: () => void) => { listeners.set(type, listener) } })
  vi.stubGlobal('document', { documentElement: { dataset: { platform: 'linux' } } })
  const ctx = { shell: { runCommand }, toolbarButton: (made: ToolbarButtonSpec) => { given = made; return button } } as unknown as ChromeContext
  const module = createSidePanelButton()
  module.init(ctx)
  return { module, ctx, spec: () => { if (given === undefined) throw new Error('no button'); return given }, button, runCommand, resize: () => { listeners.get('resize')?.() } }
}

const state = (panel: { open: boolean, side: 'left' | 'right', minWindow: number } | undefined, keys: string[] | null = ['Ctrl', 'Alt', 'B']): ShellState =>
  ({ sidePanel: panel, shortcutKeys: { 'nav.home': null, 'sidePanel.toggle': keys, 'tab.search': null } }) as unknown as ShellState

afterEach(() => { vi.unstubAllGlobals() })

describe('the side panel button', () => {
  it('is one of the chrome modules', () => {
    expect(CHROME_MODULES.map((module) => module.name)).toContain('side-panel')
  })

  it('sits in the cluster after the downloads slot, named Side panel, and runs the command', () => {
    const { spec, runCommand } = setup()
    expect(spec()).toMatchObject({ id: 'side-panel', slot: 'cluster', order: 20, label: 'Side panel' })
    spec().onClick({} as HTMLButtonElement, {} as MouseEvent)
    expect(runCommand).toHaveBeenCalledWith('sidePanel.toggle')
  })

  it('is pressed while the panel is open', () => {
    const { module, ctx, button } = setup()
    module.render?.(state({ open: true, side: 'right', minWindow: 760 }), ctx)
    expect((button['attributes'] as Map<string, string>).get('aria-pressed')).toBe('true')
    expect((button['classes'] as Set<string>).has('active')).toBe(true)
    module.render?.(state({ open: false, side: 'right', minWindow: 760 }), ctx)
    expect((button['attributes'] as Map<string, string>).get('aria-pressed')).toBe('false')
  })

  it('draws the icon of the side the panel docks to', () => {
    const { module, ctx, button } = setup()
    module.render?.(state({ open: false, side: 'left', minWindow: 760 }), ctx)
    expect(button['children']).toEqual(['left'])
    module.render?.(state({ open: false, side: 'right', minWindow: 760 }), ctx)
    expect(button['children']).toEqual(['right'])
  })

  it('names the binding that runs now in its tooltip', () => {
    const { module, ctx, button } = setup()
    module.render?.(state({ open: false, side: 'right', minWindow: 760 }), ctx)
    expect(button['title']).toBe('Side panel (Ctrl+Alt+B)')
    module.render?.(state({ open: false, side: 'right', minWindow: 760 }, null), ctx)
    expect(button['title']).toBe('Side panel')
  })

  it('is disabled, with a reason, in a window narrower than a panel needs, and again as the window is resized', () => {
    const { module, ctx, button } = setup(700)
    module.render?.(state({ open: false, side: 'right', minWindow: 760 }), ctx)
    expect(button['disabled']).toBe(true)
    expect(button['title']).toBe('Widen the window to use the side panel')

    vi.stubGlobal('window', { innerWidth: 1000, addEventListener: () => {} })
    module.render?.(state({ open: false, side: 'right', minWindow: 760 }), ctx)
    expect(button['disabled']).toBe(false)
  })

  it('is enabled when main has said nothing yet', () => {
    const { module, ctx, button } = setup(300)
    module.render?.(state(undefined), ctx)
    expect(button['disabled']).toBe(false)
  })
})
