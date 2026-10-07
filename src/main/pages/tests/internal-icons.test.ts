import { describe, expect, it } from 'vitest'
import { sniffImageType, decodeDataUrl, MAX_FAVICON_BYTES } from '../../browsing/favicon-format.js'
import { sanitizeStoredFavicon } from '../../browsing/bookmarks.js'
import { internalPageIcon } from '../internal-icons.js'
import { INTERNAL_PAGES } from '../internal-pages.js'

describe('internalPageIcon', () => {
  it('gives every page an icon of its own', () => {
    const icons = INTERNAL_PAGES.map((page) => internalPageIcon(page))
    expect(new Set(icons).size).toBe(INTERNAL_PAGES.length)
  })

  it.each(INTERNAL_PAGES)('gives %s an SVG icon that a bookmark or the history would keep', (page) => {
    const icon = internalPageIcon(page)
    const bytes = decodeDataUrl(icon, MAX_FAVICON_BYTES)
    expect(bytes).not.toBeNull()
    expect(sniffImageType(bytes!)).toBe('image/svg+xml')
    expect(sanitizeStoredFavicon(icon)).toBe(icon)
  })
})
