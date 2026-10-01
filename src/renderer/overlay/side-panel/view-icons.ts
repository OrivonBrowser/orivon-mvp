import { bookmarkIcon, bookOpenIcon, clockIcon, downloadIcon, puzzleIcon } from '../../pages/shared/icons.js'
import type { PanelIcon } from '../../../main/side-panel/panel-types.js'

/** The icon a view is known by, in the picker and in its header. */
export function viewIcon (icon: PanelIcon): SVGSVGElement {
  switch (icon) {
    case 'bookmarks': return bookmarkIcon()
    case 'history': return clockIcon()
    case 'reading': return bookOpenIcon()
    case 'downloads': return downloadIcon()
    case 'extension': return puzzleIcon()
  }
}
