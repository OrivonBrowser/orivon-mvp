import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChromeContext } from '../chrome/context.js'
import { CHROME_MODULES } from '../chrome/modules.js'
import { CONTENT_BLOCKED_NOTE, TUNNEL_NOTES, UPDATE_OFFERED_NOTE, createContentDot } from '../chrome/content-dot.js'

afterEach(() => { vi.unstubAllGlobals() })

function mount (present = true) {
  const attrs = new Map<string, string>()
  const key = {
    setAttribute: (name: string, value: string) => { attrs.set(name, value) },
    removeAttribute: (name: string) => { attrs.delete(name) }
  }
  vi.stubGlobal('document', { getElementById: (id: string) => present && id === 'site-permissions-btn' ? key : null })
  const module = createContentDot()
  module.init({} as ChromeContext)
  const render = (contentBlocked: boolean, updateOffered = false, tunnel: string | null = null): void => { module.render?.({ contentBlocked, updateOffered, tunnel } as never, {} as ChromeContext) }
  return { attrs, render }
}

describe('the content dot', () => {
  it('is one of the chrome modules', () => {
    expect(CHROME_MODULES.map((module) => module.name)).toContain('content-dot')
  })

  it('marks the key for a site with something switched off, and clears it', () => {
    const { attrs, render } = mount()
    render(true)
    expect(attrs.has('data-content-blocked')).toBe(true)
    expect(attrs.get('aria-description')).toBe(CONTENT_BLOCKED_NOTE)
    render(false)
    expect(attrs.size).toBe(0)
  })

  it('marks the key for an app with a new version offered, on its own attribute, and clears it', () => {
    const { attrs, render } = mount()
    render(false, true)
    expect(attrs.has('data-update-offered')).toBe(true)
    expect(attrs.has('data-content-blocked')).toBe(false)
    expect(attrs.get('aria-description')).toBe(UPDATE_OFFERED_NOTE)
    render(false, false)
    expect(attrs.size).toBe(0)
  })

  it('names both notes when a site has something blocked and an update offered', () => {
    const { attrs, render } = mount()
    render(true, true)
    expect(attrs.get('aria-description')).toBe(`${CONTENT_BLOCKED_NOTE}. ${UPDATE_OFFERED_NOTE}`)
    render(true, false)
    expect(attrs.has('data-update-offered')).toBe(false)
    expect(attrs.get('aria-description')).toBe(CONTENT_BLOCKED_NOTE)
  })

  it('marks the key for a page on the tunnel, in three ways, and clears it', () => {
    const { attrs, render } = mount()
    for (const tunnel of ['on', 'partial', 'down'] as const) {
      render(false, false, tunnel)
      expect(attrs.get('data-tunnel')).toBe(tunnel)
      expect(attrs.get('aria-description')).toBe(TUNNEL_NOTES[tunnel])
    }
    render(false, false, null)
    expect(attrs.size).toBe(0)
  })

  it('names the tunnel after the other notes', () => {
    const { attrs, render } = mount()
    render(true, false, 'on')
    expect(attrs.get('aria-description')).toBe(`${CONTENT_BLOCKED_NOTE}. ${TUNNEL_NOTES.on}`)
  })

  it('does nothing when the key is not in the page', () => {
    const { render } = mount(false)
    expect(() => { render(true) }).not.toThrow()
  })
})
