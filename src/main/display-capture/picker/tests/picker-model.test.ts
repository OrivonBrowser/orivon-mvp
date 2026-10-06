import { describe, expect, it } from 'vitest'
import type { TabState } from '../../../shell/tab-types.js'
import {
  audioPlan, budgetImages, cardText, defaultSegment, isPickableTab, MAX_CARD_TEXT, MAX_ICON_CHARS, MAX_THUMB_CHARS, portalCardText, portalSourceId,
  segmentMode, segmentsFor, THUMB_BUDGET_CHARS
} from '../picker-model.js'
import type { PickerCard, PickerPlatform } from '../picker-model.js'

const platform = (over: Partial<PickerPlatform> = {}): PickerPlatform => ({ os: 'linux', wayland: false, screenDenied: false, ...over })
const tab = (over: Partial<TabState> = {}): TabState => ({ id: 't', url: 'https://a.example/', isInternal: false, isNewTab: false, crashed: null, ...over } as TabState)
const card = (over: Partial<PickerCard> = {}): PickerCard => ({ id: 'c', label: 'x', sub: null, thumb: null, icon: null, self: false, ...over })
const image = (size: number): string => `data:image/jpeg;base64,${'a'.repeat(size - 23)}`

describe('segmentsFor', () => {
  it('offers tab, window and screen, and drops the screen when the page asks for no monitors', () => {
    expect(segmentsFor({})).toEqual(['tab', 'window', 'screen'])
    expect(segmentsFor({ monitorTypeSurfaces: 'include' })).toEqual(['tab', 'window', 'screen'])
    expect(segmentsFor({ monitorTypeSurfaces: 'exclude' })).toEqual(['tab', 'window'])
  })

  it('offers one segment for the system dialog, which lists windows and screens together, unless the page asks for no monitors', () => {
    expect(segmentsFor({}, 'portal')).toEqual(['tab', 'screen'])
    expect(segmentsFor({ monitorTypeSurfaces: 'exclude' }, 'portal')).toEqual(['tab', 'window'])
    expect(segmentsFor({}, 'permission')).toEqual(['tab', 'window', 'screen'])
  })
})

describe('defaultSegment', () => {
  const all = ['tab', 'window', 'screen'] as const
  it('opens on tabs without hints', () => {
    expect(defaultSegment({}, all)).toBe('tab')
  })

  it.each([
    [{ displaySurface: 'browser' }, 'tab'], [{ displaySurface: 'window' }, 'window'], [{ displaySurface: 'monitor' }, 'screen'],
    [{ preferCurrentTab: true }, 'tab'], [{ preferCurrentTab: true, displaySurface: 'monitor' }, 'tab'],
    [{ preferCurrentTab: true, selfBrowserSurface: 'exclude', displaySurface: 'monitor' }, 'screen']
  ] as const)('opens %j on %s', (hints, expected) => {
    expect(defaultSegment(hints, all)).toBe(expected)
  })

  it('falls back to tabs when the segment asked for is not offered', () => {
    expect(defaultSegment({ displaySurface: 'monitor' }, ['tab', 'window'])).toBe('tab')
  })

  it('opens a page that asks for a window on the system dialog\'s segment, which lists windows too', () => {
    expect(defaultSegment({ displaySurface: 'window' }, ['tab', 'screen'])).toBe('screen')
  })
})

describe('segmentMode', () => {
  it('lists on X11, Windows and macOS with access, and hands over to the portal on Wayland', () => {
    expect(segmentMode(platform())).toBe('list')
    expect(segmentMode(platform({ os: 'win32' }))).toBe('list')
    expect(segmentMode(platform({ os: 'darwin' }))).toBe('list')
    expect(segmentMode(platform({ wayland: true }))).toBe('portal')
  })

  it('asks for the Screen Recording permission on macOS when it is denied, and only there', () => {
    expect(segmentMode(platform({ os: 'darwin', screenDenied: true }))).toBe('permission')
    expect(segmentMode(platform({ os: 'win32', screenDenied: true }))).toBe('list')
  })
})

describe('audioPlan', () => {
  it('offers tab audio when the page asked for audio, and system audio only on Windows', () => {
    expect(audioPlan(true, {}, platform())).toEqual({ tab: true, system: false, systemDefault: false })
    expect(audioPlan(true, { systemAudio: 'include' }, platform({ os: 'win32' }))).toEqual({ tab: true, system: true, systemDefault: true })
    expect(audioPlan(true, { systemAudio: 'exclude' }, platform({ os: 'win32' }))).toEqual({ tab: true, system: true, systemDefault: false })
    expect(audioPlan(false, { systemAudio: 'include' }, platform({ os: 'win32' }))).toEqual({ tab: false, system: false, systemDefault: true })
  })
})

describe('isPickableTab', () => {
  it('offers an ordinary awake page and no other', () => {
    expect(isPickableTab(tab())).toBe(true)
    expect(isPickableTab(tab({ url: 'http://a.example/' }))).toBe(true)
    for (const over of [
      { isInternal: true }, { isNewTab: true }, { sleeping: true }, { crashed: 'oom' }, { url: 'orivon://settings/' }, { url: 'chrome-extension://abc/page.html' },
      { url: 'about:blank' }, { url: 'devtools://devtools/bundled/x.html' }, { url: 'file:///etc/passwd' }
    ]) expect(isPickableTab(tab(over))).toBe(false)
  })
})

describe('what a card may carry', () => {
  it('cuts text to one line of bounded length', () => {
    expect(cardText('  a\n  b\t c ')).toBe('a b c')
    expect(cardText('x'.repeat(MAX_CARD_TEXT + 50))).toHaveLength(MAX_CARD_TEXT)
  })

  it('keeps image data URLs within their caps and the list budget, and drops anything else', () => {
    const [small, big, text, icon, bigIcon] = budgetImages([
      card({ thumb: image(1000) }), card({ thumb: image(MAX_THUMB_CHARS + 1) }), card({ thumb: 'https://evil.example/x.png' }),
      card({ icon: image(500) }), card({ icon: image(MAX_ICON_CHARS + 1) })
    ])
    expect(small?.thumb).toHaveLength(1000)
    expect(big?.thumb).toBeNull()
    expect(text?.thumb).toBeNull()
    expect(icon?.icon).toHaveLength(500)
    expect(bigIcon?.icon).toBeNull()
  })

  it('stops giving images once the budget is spent, in card order', () => {
    const per = MAX_THUMB_CHARS
    const count = Math.floor(THUMB_BUDGET_CHARS / per) + 3
    const out = budgetImages(Array.from({ length: count }, () => card({ thumb: image(per) })))
    const kept = out.filter((c) => c.thumb !== null).length
    expect(kept).toBe(Math.floor(THUMB_BUDGET_CHARS / per))
    expect(out.slice(0, kept).every((c) => c.thumb !== null)).toBe(true)
  })

  it('names the system dialog on the one card of a Wayland segment, and says it opens at Share', () => {
    expect(portalCardText('window')).toEqual({ label: 'Choose a window in the system dialog', sub: 'Your system asks which window once you press Share.' })
    expect(portalCardText('screen')).toEqual({ label: 'Choose a window or screen in the system dialog', sub: 'Your system asks which one once you press Share.' })
  })

  it('numbers the source ids of a Wayland share far above the capture\'s own and never repeats one', () => {
    const first = portalSourceId('screen')
    const second = portalSourceId('window')
    expect(first).toMatch(/^screen:\d+:0$/)
    expect(second).toMatch(/^window:\d+:0$/)
    const number = (id: string): number => Number(id.split(':')[1])
    expect(number(first)).toBeGreaterThan(2 ** 40)
    expect(number(second)).toBe(number(first) + 1)
  })
})
