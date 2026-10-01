// A number per web contents that changes each time it starts a new page, so "this page load" can be told from the
// next without reading the address: a reload of the same address is a new load.
import type { WebContents } from 'electron'

const loads = new WeakMap<WebContents, number>()

export function loadOf (contents: WebContents): number {
  const known = loads.get(contents)
  if (known !== undefined) return known
  loads.set(contents, 0)
  contents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) loads.set(contents, (loads.get(contents) ?? 0) + 1)
  })
  return 0
}
