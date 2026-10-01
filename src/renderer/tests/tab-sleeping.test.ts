import { describe, expect, it } from 'vitest'
import type { ShellState, TabState } from '../../main/shell/tabs.js'
import type { ChromeContext } from '../chrome/context.js'
import { decorateTabSleeping } from '../chrome/tab-sleeping.js'

// A node-only stand-in for the few parts of the DOM the decorator touches.
class FakeEl {
  title = ''
  classes = new Set<string>()
  attrs = new Map<string, string>()
  classList = { add: (...names: string[]) => { for (const name of names) this.classes.add(name) } }
  setAttribute (name: string, value: string): void { this.attrs.set(name, value) }
  getAttribute (name: string): string | null { return this.attrs.get(name) ?? null }
}

const tab = (over: Partial<TabState> = {}): TabState => ({
  id: 'a', url: 'https://example.com/page', displayUrl: 'https://example.com/page', title: 'Example', canGoBack: false, canGoForward: false, loading: false,
  favicon: null, isNewTab: false, splitWith: null, isInternal: false, pinned: false, muted: false, audible: false, crashed: null, connection: 'none', ...over
})

function decorate (over: Partial<TabState>, label: string | null = 'Example'): FakeEl {
  const el = new FakeEl()
  el.title = 'Example\nexample.com'
  if (label !== null) el.attrs.set('aria-label', label)
  decorateTabSleeping(el as unknown as HTMLElement, tab(over), { tabs: [] } as unknown as ShellState, {} as ChromeContext)
  return el
}

describe('the sleeping tab decorator', () => {
  it('leaves an awake tab alone', () => {
    const el = decorate({ sleeping: false })
    expect(el.classes.has('sleeping')).toBe(false)
    expect(el.title).toBe('Example\nexample.com')
    expect(el.attrs.get('aria-label')).toBe('Example')
  })

  it('treats a tab with no sleeping field as awake', () => {
    expect(decorate({}).classes.has('sleeping')).toBe(false)
  })

  it('marks a sleeping tab and ends its tooltip and name with ", sleeping"', () => {
    const el = decorate({ sleeping: true })
    expect(el.classes.has('sleeping')).toBe(true)
    expect(el.title).toBe('Example\nexample.com, sleeping')
    expect(el.attrs.get('aria-label')).toBe('Example, sleeping')
  })

  it('builds the name itself when the earlier decorators set none', () => {
    expect(decorate({ sleeping: true }, null).attrs.get('aria-label')).toBe('Example, sleeping')
    expect(decorate({ sleeping: true, title: '' }, null).attrs.get('aria-label')).toBe('New tab, sleeping')
  })
})
