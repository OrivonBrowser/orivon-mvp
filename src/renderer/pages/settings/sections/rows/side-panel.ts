import type { Row } from '../../model.js'

/** Rows spread into the Side panel group of Appearance, so a feature adds its rows here and edits no other file. */
export const sidePanelRows: readonly Row[] = [
  {
    id: 'side-panel-side',
    label: 'Show the side panel on the',
    help: 'The panel beside the page that lists your bookmarks, history and more. Open it from More tools in the menu.',
    keywords: ['sidebar', 'panel', 'dock', 'left', 'right', 'bookmarks', 'history'],
    group: 'Side panel',
    control: {
      type: 'choice',
      key: 'sidePanel.side',
      options: [
        { value: 'right', label: 'Right' },
        { value: 'left', label: 'Left' }
      ]
    }
  }
]
