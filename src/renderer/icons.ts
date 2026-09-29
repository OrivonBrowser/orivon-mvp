// Icons built at runtime, one per dynamic list item (a tab, a bookmark) --
// the toolbar's fixed icons are static inline SVG in index.html instead.
//
// Never innerHTML (security-model.md T1/T10/T12/T17) -- every element here
// is built through createElementNS, even though none of this data is
// currently attacker-controlled.
//
// Path data for globeIcon/closeIcon is hand-ported from lucide's `globe`
// and `x` icons (ISC licence, https://lucide.dev) onto their own default
// attributes (24x24 viewBox, stroke-width 2, round caps/joins). See
// README.md for why no icon library is a dependency here.
//
// `svg`/`path`/`circle`/`rect`/`line` live in `./pages/shared/svg-primitives.js`
// and are re-exported here for `./web3-shield.ts`, `./site-info/icons.ts`
// and `./grant-icons.ts` to build on -- one set of primitives, not a copy in
// every file that draws an inline SVG (code-guidelines.md Rule 3). They sit
// under `pages/` rather than here so `pages/shared/icons.ts` can import them
// too without reaching outside the one prefix an internal page's dev-mode
// request may come from (route.ts).
import { circle, line, path, rect, svg } from './pages/shared/svg-primitives.js'

export { circle, line, path, rect, svg }

/** Generic favicon stand-in -- the fallback inside faviconElement below,
 * for anything with no real favicon yet or whose favicon fails to load.
 * Real favicons are fetched by src/main/favicon.ts. */
export function globeIcon (): SVGSVGElement {
  const el = svg('0 0 24 24')
  el.append(
    path('M21.54 15H17a2 2 0 0 0-2 2v4.54', '2'),
    path('M7 3.34V5a3 3 0 0 0 3 3a2 2 0 0 1 2 2c0 1.1.9 2 2 2a2 2 0 0 0 2-2c0-1.1.9-2 2-2h3.17', '2'),
    path('M11 21.95V18a2 2 0 0 0-2-2a2 2 0 0 1-2-2v-1a2 2 0 0 0-2-2H2.05', '2'),
    circle(12, 12, 10)
  )
  return el
}

/** A favicon as an `<img>`, or the generic globe when there is none.
 *
 * Always a `data:` URL, never the site's own https one: main fetches every
 * favicon and re-encodes it (src/main/favicon.ts) precisely so no privileged
 * view makes a network request for an icon, and the CSPs here are
 * `img-src 'self' data:` to match. Shared by the tab strip, the bookmarks bar
 * and the dashboard's tiles -- all three answer the same question, so this is
 * one implementation of it (code-guidelines.md Rule 3).
 *
 * On a decode failure the image swaps ITSELF for the globe, so a caller can
 * append the result and forget about it -- in practice that is a corrupt
 * cached entry, not a network problem, since the bytes are already local. */
export function faviconElement (dataUrl: string | null): HTMLImageElement | SVGSVGElement {
  if (dataUrl === null) return globeIcon()
  const img = document.createElement('img')
  img.alt = ''
  img.decoding = 'async'
  img.referrerPolicy = 'no-referrer'
  img.addEventListener('error', () => { img.replaceWith(globeIcon()) }, { once: true })
  img.src = dataUrl
  return img
}

/** The tab strip's close (x) button, shared with the bookmarks bar's remove button. */
export function closeIcon (): SVGSVGElement {
  const el = svg('0 0 24 24')
  el.append(path('M18 6 6 18', '2.5'), path('m6 6 12 12', '2.5'))
  return el
}
