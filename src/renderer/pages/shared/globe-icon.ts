// The globe: a generic site mark, and the stand-in a favicon falls back to. Path data is hand-ported from lucide's `globe`
// icon (ISC licence, https://lucide.dev) onto its default attributes. Under `pages/shared/` so the Settings page can draw
// it; `../../icons.ts` re-exports it for the chrome.
import { circle, path, svg } from './svg-primitives.js'

/** Generic favicon stand-in -- the fallback inside faviconElement below,
 * for anything with no real favicon yet or whose favicon fails to load.
 * Real favicons are fetched by src/main/browsing/favicon-fetch.ts. */
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
