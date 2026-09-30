import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TabState } from '../../main/shell/tabs.js'
import type { ShellState } from '../../main/shell/tabs.js'
import type { ChromeContext } from '../chrome/context.js'

// A node-only stand-in for the few parts of the DOM the decorator touches.
class FakeEl {
  title = ''
  classes = new Set<string>()
  attrs = new Map<string, string>()
  children: unknown[] = []
  fav: FakeEl | null = null
  classList = {
    add: (...names: string[]) => { for (const name of names) this.classes.add(name) },
    remove: (...names: string[]) => { for (const name of names) this.classes.delete(name) }
  }

  setAttribute (name: string, value: string): void { this.attrs.set(name, value) }
  replaceChildren (...nodes: unknown[]): void { this.children = nodes }
  querySelector (selector: string): FakeEl | null { return selector === '.fav' ? this.fav : null }
}

vi.mock('../pages/shared/icons.js', () => ({ warningIcon: () => 'warning' }))

const { decorateTabCrashed } = await import('../chrome/tab-crashed.js')

afterEach(() => { vi.unstubAllGlobals() })

const tab = (over: Partial<TabState> = {}): TabState => ({
  id: 'a', url: 'https://example.com/page', displayUrl: 'https://example.com/page', title: 'Example', canGoBack: false, canGoForward: false, loading: false,
  favicon: null, isNewTab: false, splitWith: null, isInternal: false, pinned: false, muted: false, audible: false, crashed: null, connection: 'none', ...over
})

function decorate (over: Partial<TabState>, title = 'Example\nexample.com'): FakeEl {
  const el = new FakeEl()
  el.title = title
  el.fav = new FakeEl()
  el.fav.classes.add('loading')
  decorateTabCrashed(el as unknown as HTMLElement, tab(over), { tabs: [] } as unknown as ShellState, {} as ChromeContext)
  return el
}

describe('the crashed tab decorator', () => {
  it('leaves a healthy tab alone', () => {
    const el = decorate({ crashed: null })
    expect(el.classes.has('crashed')).toBe(false)
    expect(el.title).toBe('Example\nexample.com')
    expect(el.fav?.children).toEqual([])
    expect(el.attrs.size).toBe(0)
  })

  it('marks a crashed tab, swaps its icon for the warning and drops the spinner', () => {
    const el = decorate({ crashed: 'crashed' })
    expect(el.classes.has('crashed')).toBe(true)
    expect(el.fav?.children).toEqual(['warning'])
    expect(el.fav?.classes.has('loading')).toBe(false)
  })

  it('adds its line to the end of the tooltip', () => {
    expect(decorate({ crashed: 'oom' }).title).toBe('Example\nexample.com\nThis tab crashed')
    expect(decorate({ crashed: 'oom' }, '').title).toBe('This tab crashed')
  })

  it('says so in the accessible name, for a titled and an untitled tab', () => {
    expect(decorate({ crashed: 'killed' }).attrs.get('aria-label')).toBe('Example, crashed')
    expect(decorate({ crashed: 'killed', title: '' }).attrs.get('aria-label')).toBe('New Tab, crashed')
  })

  it('does not throw for a tab without an icon box', () => {
    const el = new FakeEl()
    expect(() => { decorateTabCrashed(el as unknown as HTMLElement, tab({ crashed: 'crashed' }), { tabs: [] } as unknown as ShellState, {} as ChromeContext) }).not.toThrow()
    expect(el.classes.has('crashed')).toBe(true)
  })
})
