// The one way a view is put on screen in a window. See README.md's Design notes for why a bare
// `addChildView` is not enough on Electron 44.
import { View } from 'electron'

/** Puts `view` in `parent` (at `index` when given, else on top) so that its page is shown: visible, drawing, running
 * `requestAnimationFrame`. A view added back after it left a window stays hidden until the window's children change
 * once more; one put below a page that is on screen, until that page is hidden and shown again, in a later turn than
 * the one that attached `view`. `above` lists the views on screen over `view`'s place. */
export function attachShown (parent: View, view: View, index?: number, above: readonly View[] = []): void {
  if (index === undefined) parent.addChildView(view)
  else parent.addChildView(view, index)
  view.setVisible(true)
  completeAttach(parent)
  if (above.length > 0) setTimeout(() => { showAgain(parent, view, above) }, 0)
}

function completeAttach (parent: View): void {
  let marker: View
  try {
    marker = new View()
  } catch {
    // Not inside Electron (a unit test with no `View`): there is no window whose children could be stuck.
    return
  }
  parent.addChildView(marker)
  parent.removeChildView(marker)
}

/** Hides and shows, in one turn, each of `others` that is on screen: what makes a page that was left hidden under
 * them (`view`) show. A no-op unless `view` is still in `parent`. */
export function showAgain (parent: View, view: View, others: readonly View[]): void {
  try {
    const placed = parent.children
    if (!placed.includes(view)) return
    for (const other of others) {
      if (!placed.includes(other) || !other.getVisible()) continue
      other.setVisible(false)
      other.setVisible(true)
    }
  } catch {
    // The window was closed in the meantime: there is nothing left to show.
  }
}
