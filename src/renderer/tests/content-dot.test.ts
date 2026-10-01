import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChromeContext } from '../chrome/context.js'
import { CHROME_MODULES } from '../chrome/modules.js'
import { CONTENT_BLOCKED_NOTE, createContentDot } from '../chrome/content-dot.js'

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
  const render = (contentBlocked: boolean): void => { module.render?.({ contentBlocked } as never, {} as ChromeContext) }
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

  it('does nothing when the key is not in the page', () => {
    const { render } = mount(false)
    expect(() => { render(true) }).not.toThrow()
  })
})
