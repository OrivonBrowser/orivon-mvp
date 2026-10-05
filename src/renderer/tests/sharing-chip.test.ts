import { describe, expect, it, vi } from 'vitest'
import type { ChromeContext, ToolbarButtonSpec } from '../chrome/context.js'
import { CHROME_MODULES } from '../chrome/modules.js'
import { createSharingChip, sharingLabel } from '../chrome/sharing-chip.js'
import { sharingLabel as tabSharingLabel, tabName, tabTooltip } from '../chrome/tab-badges.js'
import type { TabState } from '../../main/shell/tabs.js'

vi.mock('../pages/shared/site-kind-icons.js', () => ({ SITE_KIND_ICONS: { screenShare: () => ({ icon: 'screen' }) } }))

class FakeEl {
  hidden = false
  title = ''
  attrs = new Map<string, string>()
  setAttribute (name: string, value: string): void { this.attrs.set(name, value) }
}

function mount () {
  const act = vi.fn(() => Promise.resolve(undefined))
  const button = new FakeEl()
  let given: ToolbarButtonSpec | undefined
  const ctx = { shell: { act }, toolbarButton: (spec: ToolbarButtonSpec) => { given = spec; return button } } as unknown as ChromeContext
  const chip = createSharingChip()
  chip.init(ctx)
  return { button, act, render: (sharing: unknown): void => { chip.render?.({ sharing } as never, ctx) }, spec: () => { if (given === undefined) throw new Error('no button'); return given } }
}

describe('the sharing chip', () => {
  it('sits in the address slot between the permissions chip and the pop-up chip', () => {
    expect(mount().spec()).toMatchObject({ id: 'sharing-chip', slot: 'address', order: 11 })
    const names = CHROME_MODULES.map((module) => module.name)
    expect(names.indexOf('site-access')).toBeLessThan(names.indexOf('sharing-chip'))
    expect(names.indexOf('sharing-chip')).toBeLessThan(names.indexOf('popups-chip'))
  })

  it('is hidden until the page in front shares, then names what and with whom', () => {
    const m = mount()
    expect(m.button.hidden).toBe(true)
    m.render({ kind: 'screen', origin: 'meet.example', count: 1 })
    expect(m.button.hidden).toBe(false)
    expect(m.button.attrs.get('aria-label')).toBe('Sharing your screen with meet.example')
    expect(m.button.title).toBe('Sharing your screen with meet.example')
    m.render(null)
    expect(m.button.hidden).toBe(true)
    m.render(undefined)
    expect(m.button.hidden).toBe(true)
  })

  it('brings the bar back when clicked', () => {
    const m = mount()
    m.spec().onClick(m.button as never, {} as MouseEvent)
    expect(m.act).toHaveBeenCalledWith('sharing.bar', {})
  })
})

describe('sharingLabel', () => {
  it('says each kind and counts further shares', () => {
    expect(sharingLabel({ kind: 'window', origin: 'a.example', count: 1 })).toBe('Sharing a window with a.example')
    expect(sharingLabel({ kind: 'tab', origin: 'a.example', count: 3 })).toBe('Sharing a tab with a.example and 2 more')
  })
})

describe('a tab in a share', () => {
  const tab = (over: Partial<TabState>): TabState => ({ title: 'Call', displayUrl: 'https://meet.example/', isNewTab: false, muted: false, audible: false, splitWith: null, ...over } as TabState)

  it.each([
    [{ sharing: 'screen' }, 'Sharing your screen'], [{ sharing: 'window' }, 'Sharing a window'], [{ sharing: 'tab' }, 'Sharing a tab'],
    [{ shared: true }, 'This tab is being shared'], [{ sharing: 'tab', shared: true }, 'Sharing a tab'], [{}, null]
  ] as const)('%j is named %s', (over, label) => {
    expect(tabSharingLabel(tab(over))).toBe(label)
  })

  it('adds the share to the tooltip and the accessible name', () => {
    expect(tabTooltip(tab({ sharing: 'screen' }))).toBe('Call\nmeet.example\nSharing your screen')
    expect(tabName(tab({ shared: true }))).toBe('Call, this tab is being shared')
    expect(tabName(tab({}))).toBe('Call')
  })
})
